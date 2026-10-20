import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverBooks } from "./ingestion/books.js";
import { CHUNKER_VERSION, parseMarkdown } from "./ingestion/markdown.js";
import { createEmbeddingProvider } from "./providers/index.js";
import { appConfigSchema } from "./schemas/config.js";
import { indexOptionsSchema } from "./schemas/library.js";
import { searchInputSchema } from "./schemas/search.js";
import type { SearchOptions } from "./schemas/search.js";
import { SqliteContentRepository } from "./storage/content.js";
import type { IndexedSource } from "./storage/content.js";
import { SqliteSearchRepository } from "./storage/vectors.js";
import type { SearchRepository, SearchResponse } from "./storage/search.js";
export type { SearchResponse } from "./storage/search.js";
import type { AppConfig, EmbeddingProvider, IndexOptions } from "./types.js";

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

/** Orchestrates independent stores. Source changes and vector jobs commit together in content.sqlite. */
export class BookLibrary {
  readonly config: AppConfig;
  private contentRepository?: SqliteContentRepository;
  private searchRepository?: SearchRepository;
  private readonly provider?: EmbeddingProvider;

  constructor(
    config: AppConfig,
    dependencies: {
      provider?: EmbeddingProvider;
      search?: SearchRepository;
      /** @deprecated Use search. */
      vectors?: SearchRepository;
    } = {},
  ) {
    this.config = parseLibraryConfig(config);
    this.provider =
      dependencies.provider ??
      (this.config.embedding ? createEmbeddingProvider(this.config.embedding) : undefined);
    this.searchRepository = dependencies.search ?? dependencies.vectors;
  }

  get content(): SqliteContentRepository {
    this.contentRepository ??= new SqliteContentRepository(
      join(this.config.dataDir, "content.sqlite"),
    );
    return this.contentRepository;
  }

  private searchStore(): SearchRepository {
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
      const result = this.content.applySnapshot(discovery.books, sources, this.provider?.profileId);
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
    const current = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    // Payload delivery is retryable independently of embedding generation.
    // The full snapshot also restores a lost/migrated search DB on index/embed.
    for (const chunk of chunks) this.content.enqueueEmbedding(chunk, "*");
    let vectors: SearchRepository;
    try {
      vectors = this.searchStore();
      await vectors.upsertChunks(chunks);
      for (const job of this.content.jobs()) {
        if (job.operation === "upsert" && job.profileId === "*") this.content.completeJob(job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search storage unavailable";
      for (const job of this.content.jobs()) {
        if (job.operation === "upsert" && job.profileId === "*")
          this.content.failJob(job.id, message);
      }
      if (this.provider)
        for (const chunk of chunks) this.content.enqueueEmbedding(chunk, this.provider.profileId);
      report.warnings.push(`Search index update failed; content is saved. ${message}`);
      report.failed = Math.max(1, chunks.length);
      return report;
    }
    // Keep old rows until cache reuse: a rename or formatting-only edit may preserve model input.
    try {
      for (const job of this.content.jobs()) {
        if (job.operation === "upsert" && current.get(job.chunkId)?.inputHash !== job.inputHash) {
          this.content.completeJob(job.id);
        }
      }
      const provider = this.provider;
      if (!provider) {
        if (chunks.length)
          report.warnings.push(
            "No embedding provider configured. Lexical search index is ready; configure a provider and run embed for semantic search.",
          );
        return report;
      }
      for (const chunk of chunks) {
        if (!(await vectors.get(provider.profileId, chunk.id, chunk.inputHash)))
          this.content.enqueueEmbedding(chunk, provider.profileId);
      }
      // Reconcile cached vectors even with --no-embed: this performs no inference or HTTP calls.
      for (const job of this.content.jobs(provider.profileId)) {
        if (job.operation !== "upsert") continue;
        const cached =
          (await vectors.get(provider.profileId, job.chunkId, job.inputHash)) ??
          (await vectors.findCached(provider.profileId, job.inputHash));
        if (!cached) continue;
        await vectors.upsert(provider.profileId, current.get(job.chunkId)!, cached);
        this.content.completeJob(job.id);
        report.reused++;
      }
      if (!generate) {
        if (this.content.jobs(provider.profileId).length)
          report.warnings.push("Embedding jobs queued. Run embed to complete the semantic index.");
        return report;
      }
      const jobs = this.content
        .jobs(provider.profileId)
        .filter((job) => job.operation === "upsert");
      const batchSize = provider.config.batchSize;
      for (let offset = 0; offset < jobs.length; offset += batchSize) {
        const pending = jobs
          .slice(offset, offset + batchSize)
          .filter((job) => current.get(job.chunkId)?.inputHash === job.inputHash);
        const uncached = [];
        for (const job of pending) {
          const vector =
            (await vectors.get(provider.profileId, job.chunkId, job.inputHash)) ??
            (await vectors.findCached(provider.profileId, job.inputHash));
          if (!vector) {
            uncached.push(job);
            continue;
          }
          await vectors.upsert(provider.profileId, current.get(job.chunkId)!, vector);
          this.content.completeJob(job.id);
          report.reused++;
        }
        if (!uncached.length) continue;
        try {
          // Deduplicate identical model inputs within a batch as well as across runs.
          const inputs = [
            ...new Map(
              uncached.map((job) => [job.inputHash, current.get(job.chunkId)!.embeddingText]),
            ).entries(),
          ];
          const embeddings = await provider.embed(
            inputs.map(([, text]) => text),
            "document",
          );
          if (embeddings.length !== inputs.length || !embeddings[0]?.length)
            throw new Error("Provider returned an invalid embedding batch.");
          const {
            provider: name,
            baseUrl,
            model,
            dimensions,
            documentPrefix,
            queryPrefix,
          } = provider.config;
          await vectors.ensureProfile(provider.profileId, embeddings[0]!.length, {
            provider: name,
            baseUrl,
            model,
            dimensions,
            documentPrefix,
            queryPrefix,
          });
          const byHash = new Map(inputs.map(([inputHash], i) => [inputHash, embeddings[i]!]));
          for (const job of uncached) {
            await vectors.upsert(
              provider.profileId,
              current.get(job.chunkId)!,
              byHash.get(job.inputHash)!,
            );
            this.content.completeJob(job.id);
            report.embedded++;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Embedding request failed";
          const outstanding = new Set(this.content.jobs(provider.profileId).map((job) => job.id));
          const failed = uncached.filter((job) => outstanding.has(job.id));
          for (const job of failed) this.content.failJob(job.id, message);
          report.failed += failed.length;
          report.warnings.push(message);
          // Stop this run on provider failure; remaining jobs persist for a later retry.
          break;
        }
      }
      return report;
    } finally {
      // Delete only after retained inputs have moved to their new chunk IDs.
      const obsolete = new Set([
        ...(await vectors.listChunkIds()),
        ...(await vectors.listEntries()).map((entry) => entry.chunkId),
      ]);
      for (const chunkId of obsolete) {
        if (!current.has(chunkId)) await vectors.removeChunk(chunkId);
      }
      for (const job of this.content.jobs()) {
        if (job.operation !== "delete") continue;
        if (!current.has(job.chunkId)) await vectors.removeChunk(job.chunkId);
        this.content.completeJob(job.id);
      }
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
    let response: SearchResponse;
    try {
      response = await store.search(request);
    } catch (error) {
      if (effectiveMode !== "hybrid") throw error;
      warnings.push(
        `Semantic search unavailable; returning lexical results. ${error instanceof Error ? error.message : ""}`,
      );
      response = await store.search({ ...request, mode: "lexical", vector: undefined });
    }
    return { ...response, mode, warnings: [...warnings, ...response.warnings] };
  }

  async status() {
    let vectorStatus: {
      count: number;
      profiles: { id: string; dimensions: number }[];
      error?: string;
    };
    try {
      const vectors = this.searchStore();
      vectorStatus = { count: await vectors.count(), profiles: await vectors.listProfiles() };
    } catch (error) {
      vectorStatus = {
        count: 0,
        profiles: [],
        error: error instanceof Error ? error.message : "Vector storage unavailable",
      };
    }
    return {
      ...this.content.status(),
      vectors: vectorStatus,
      activeProfile: this.provider?.profileId ?? null,
    };
  }

  async close(): Promise<void> {
    try {
      await this.searchRepository?.close();
    } finally {
      this.contentRepository?.close();
    }
  }
}

export async function initializeLibrary(config: AppConfig): Promise<void> {
  config = parseLibraryConfig(config);
  await mkdir(config.booksDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  const library = new BookLibrary(config);
  try {
    const status = await library.status();
    if (status.vectors.error) throw new Error(status.vectors.error);
  } finally {
    await library.close();
  }
}
