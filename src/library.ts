import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverBooks } from "./ingestion/books.js";
import { CHUNKER_VERSION, parseMarkdown } from "./ingestion/markdown.js";
import { createEmbeddingProvider } from "./providers/index.js";
import { appConfigSchema } from "./config.js";
import { z } from "zod";
import { searchInputSchema } from "./storage/search.js";
import type { SearchOptions } from "./storage/search.js";
import { SqliteContentRepository } from "./storage/content.js";
import type { IndexedSource } from "./storage/content.js";
import { SqliteSearchRepository } from "./storage/search.js";
import type { SearchResponse } from "./storage/search.js";
import type { AppConfig, EmbeddingProvider, StoredChunk } from "./types.js";

// Only the public call's structure; the default embedding behavior stays in index().
const indexOptionsSchema = z.object({
  embed: z.boolean().optional(),
});

export type IndexOptions = z.infer<typeof indexOptionsSchema>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function parseLibraryConfig(config: AppConfig): AppConfig {
  const validation = appConfigSchema.safeParse(config);
  if (!validation.success) {
    throw new Error("Invalid library configuration structure. Check required fields and types.");
  }
  return validation.data;
}

export interface IndexReport {
  books: number;
  updated: number;
  unchanged: number;
  removed: number;
  embedded: number;
  reused: number;
  failed: number;
  warnings: string[];
}

/** Orchestrates independent stores. Missing search records are derived from the saved content snapshot. */
export class BookLibrary {
  readonly config: AppConfig;
  private contentRepository?: SqliteContentRepository;
  private searchRepository?: SqliteSearchRepository;
  private readonly provider?: EmbeddingProvider;

  constructor(
    config: AppConfig,
    dependencies: {
      provider?: EmbeddingProvider;
      search?: SqliteSearchRepository;
    } = {},
  ) {
    this.config = parseLibraryConfig(config);
    this.provider =
      dependencies.provider ??
      (this.config.embedding ? createEmbeddingProvider(this.config.embedding) : undefined);
    this.searchRepository = dependencies.search;
  }

  get content(): SqliteContentRepository {
    this.contentRepository ??= new SqliteContentRepository(
      join(this.config.dataDir, "content.sqlite"),
    );
    return this.contentRepository;
  }

  private searchStore(): SqliteSearchRepository {
    // Keep the existing filename so schema migration can reuse stored embeddings.
    this.searchRepository ??= new SqliteSearchRepository(
      join(this.config.dataDir, "vectors.sqlite"),
    );
    return this.searchRepository;
  }

  async index(options: IndexOptions = {}): Promise<IndexReport> {
    const validation = indexOptionsSchema.safeParse(options);
    if (!validation.success) {
      throw new Error("Invalid indexing options structure: expected an optional boolean embed.");
    }
    const { embed } = validation.data;
    const release = this.content.acquireWriterLock();
    let run: number | undefined;
    try {
      run = this.content.startRun();
      // A missing configured root is an error, never an empty snapshot implying deletions.
      const discovery = await discoverBooks(this.config.booksDir);
      const sources: IndexedSource[] = [];
      for (const book of discovery.books) {
        for (const file of book.files) {
          const id = hash(`${book.id}\0${file.relativePath}`);
          const contentHash = hash(file.markdown);
          const fingerprint = hash(
            JSON.stringify({
              version: CHUNKER_VERSION,
              chunking: this.config.chunking,
              title: book.title,
            }),
          );
          const existing = this.content.getDocumentState(id);
          sources.push({
            id,
            bookId: book.id,
            relativePath: file.relativePath,
            order: file.order,
            markdown: file.markdown,
            hash: contentHash,
            fingerprint,
            ...(existing?.hash === contentHash && existing.fingerprint === fingerprint
              ? {}
              : {
                  parsed: parseMarkdown(id, file.markdown, book.title, this.config.chunking),
                }),
          });
        }
      }
      const result = this.content.applySnapshot(discovery.books, sources);
      const report: IndexReport = {
        books: discovery.books.length,
        ...result,
        embedded: 0,
        reused: 0,
        failed: 0,
        warnings: discovery.warnings,
      };
      const embedding = await this.synchronizeSearch(embed !== false);
      Object.assign(report, {
        embedded: embedding.embedded,
        reused: embedding.reused,
        failed: embedding.failed,
      });
      report.warnings.push(...embedding.warnings);
      this.content.finishRun(run, report.failed ? "partial" : "completed", report);
      return report;
    } catch (error) {
      if (run !== undefined)
        this.content.finishRun(run, "failed", {
          error: error instanceof Error ? error.message : "Indexing failed",
        });
      throw error;
    } finally {
      release();
    }
  }

  async embed(): Promise<Pick<IndexReport, "embedded" | "reused" | "failed" | "warnings">> {
    if (!this.provider) throw new Error("Configure an embedding provider before running embed.");
    const release = this.content.acquireWriterLock();
    let run: number | undefined;
    try {
      run = this.content.startRun();
      const report = await this.synchronizeSearch(true);
      this.content.finishRun(run, report.failed ? "partial" : "completed", report);
      return report;
    } catch (error) {
      if (run !== undefined)
        this.content.finishRun(run, "failed", {
          error: error instanceof Error ? error.message : "Embedding failed",
        });
      throw error;
    } finally {
      release();
    }
  }

  private async synchronizeSearch(
    generate: boolean,
  ): Promise<Pick<IndexReport, "embedded" | "reused" | "failed" | "warnings">> {
    const report = { embedded: 0, reused: 0, failed: 0, warnings: [] as string[] };
    const chunks = this.content.listChunks();
    let store: SqliteSearchRepository;
    try {
      store = this.searchStore();
      store.upsertChunks(chunks);
    } catch (error) {
      report.warnings.push(
        `Search index update failed; content is saved. ${error instanceof Error ? error.message : "Search storage unavailable"}`,
      );
      report.failed = Math.max(1, chunks.length);
      return report;
    }
    try {
      const provider = this.provider;
      if (!provider) {
        if (chunks.length)
          report.warnings.push(
            "No embedding provider configured. Lexical search index is ready; configure a provider and run embed for semantic search.",
          );
        return report;
      }
      // Group the entire snapshot by model input, so each input is checked/generated once.
      const missing = new Map<string, StoredChunk[]>();
      for (const chunk of chunks) {
        if (store.get(provider.profileId, chunk.id, chunk.inputHash)) continue;
        const group = missing.get(chunk.inputHash) ?? [];
        group.push(chunk);
        missing.set(chunk.inputHash, group);
      }
      // Move every reusable input before HTTP can fail and obsolete IDs are removed.
      for (const [hash, group] of missing) {
        const cached = store.findCached(provider.profileId, hash);
        if (!cached) continue;
        for (const chunk of group) {
          store.upsert(provider.profileId, chunk, cached);
          report.reused++;
        }
        missing.delete(hash);
      }
      if (!generate) {
        if (missing.size)
          report.warnings.push("Embeddings are missing. Run embed to complete the semantic index.");
        return report;
      }
      const groups = [...missing.values()];
      for (let offset = 0; offset < groups.length; offset += provider.config.batchSize) {
        const batch = groups.slice(offset, offset + provider.config.batchSize);
        let completed = 0;
        try {
          const embeddings = await provider.embed(
            batch.map((group) => group[0]!.embeddingText),
            "document",
          );
          if (embeddings.length !== batch.length || !embeddings[0]?.length)
            throw new Error("Provider returned an invalid embedding batch.");
          store.ensureProfile(provider.profileId, embeddings[0]!.length);
          for (const [i, group] of batch.entries()) {
            for (const chunk of group) {
              store.upsert(provider.profileId, chunk, embeddings[i]!);
              completed++;
              report.embedded++;
            }
          }
        } catch (error) {
          report.failed = batch.reduce((sum, group) => sum + group.length, 0) - completed;
          report.warnings.push(error instanceof Error ? error.message : "Embedding update failed");
          break;
        }
      }
      return report;
    } finally {
      // Reuse old inputs before deleting obsolete IDs (including renamed files).
      const current = new Set(chunks.map((chunk) => chunk.id));
      for (const id of store.listChunkIds()) if (!current.has(id)) store.removeChunk(id);
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const validation = searchInputSchema.safeParse({ query, options });
    if (!validation.success) {
      switch (validation.error.issues[0]?.path.join(".")) {
        case "query":
          throw new Error("Search query must be a string.");
        case "options.mode":
          throw new Error("Search mode must be lexical, vector or hybrid.");
        case "options.limit":
          throw new Error("Search limit must be between 1 and 100.");
        case "options.bookId":
          throw new Error("Search book ID must be a string.");
        default:
          throw new Error("Search options must be an object.");
      }
    }
    const {
      query: searchQuery,
      options: { mode = "hybrid", limit = 10, bookId },
    } = validation.data;
    if (!searchQuery.trim()) throw new Error("Search query must not be empty.");
    if (searchQuery.length > 8192)
      throw new Error("Search query is too long (maximum 8192 characters).");
    if (limit < 1 || limit > 100) throw new Error("Search limit must be between 1 and 100.");
    const store = this.searchStore();
    const warnings: string[] = [];
    let vector: number[] | undefined;
    let effectiveMode = mode;
    if (mode !== "lexical") {
      try {
        if (!this.provider) throw new Error("No embedding provider configured.");
        vector = (await this.provider.embed([searchQuery], "query"))[0];
        if (!vector?.length) throw new Error("Provider returned an invalid query embedding.");
      } catch (error) {
        if (mode === "vector") throw error;
        effectiveMode = "lexical";
        warnings.push(
          `Semantic search unavailable; returning lexical results. ${error instanceof Error ? error.message : ""}`,
        );
      }
    }
    const request = {
      query: searchQuery,
      mode: effectiveMode,
      limit,
      bookId,
      profileId: this.provider?.profileId,
      vector,
    };
    const response = store.search(request);
    return { ...response, mode, warnings: [...warnings, ...response.warnings] };
  }

  status() {
    let vectorStatus: {
      count: number;
      profiles: { id: string; dimensions: number }[];
      error?: string;
      pendingEmbeddings: number | null;
    };
    try {
      const vectors = this.searchStore();
      vectorStatus = {
        count: vectors.count(),
        profiles: vectors.listProfiles(),
        pendingEmbeddings: this.provider
          ? this.content
              .listChunks()
              .filter((chunk) => !vectors.get(this.provider!.profileId, chunk.id, chunk.inputHash))
              .length
          : null,
      };
    } catch (error) {
      vectorStatus = {
        count: 0,
        profiles: [],
        pendingEmbeddings: null,
        error: error instanceof Error ? error.message : "Vector storage unavailable",
      };
    }
    return {
      ...this.content.status(),
      vectors: vectorStatus,
      activeProfile: this.provider?.profileId ?? null,
    };
  }

  close(): void {
    try {
      this.searchRepository?.close();
    } finally {
      this.contentRepository?.close();
    }
  }
}

export async function initializeLibrary(config: AppConfig): Promise<void> {
  const library = new BookLibrary(config);
  await mkdir(library.config.booksDir, { recursive: true });
  await mkdir(library.config.dataDir, { recursive: true });
  try {
    const status = library.status();
    if (status.vectors.error) throw new Error(status.vectors.error);
  } finally {
    library.close();
  }
}
