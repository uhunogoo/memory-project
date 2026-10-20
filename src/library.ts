import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverBooks } from "./ingestion/books.js";
import { CHUNKER_VERSION, parseMarkdown } from "./ingestion/markdown.js";
import { createEmbeddingProvider } from "./providers/index.js";
import { searchInputSchema } from "./schemas/search.js";
import type { SearchMode, SearchOptions } from "./schemas/search.js";
import { SqliteContentRepository } from "./storage/content.js";
import type { IndexedSource } from "./storage/content.js";
import { SqliteVectorRepository } from "./storage/vectors.js";
import type { VectorRepository } from "./storage/vectors.js";
import type { AppConfig, EmbeddingProvider, SearchResult, StoredChunk } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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

export interface SearchResponse {
  mode: SearchMode;
  warnings: string[];
  results: SearchResult[];
}

/** Orchestrates independent stores. Source changes and vector jobs commit together in content.sqlite. */
export class BookLibrary {
  readonly content: SqliteContentRepository;
  private vectors?: VectorRepository;
  private readonly provider?: EmbeddingProvider;

  constructor(
    readonly config: AppConfig,
    dependencies: { provider?: EmbeddingProvider; vectors?: VectorRepository } = {},
  ) {
    this.provider =
      dependencies.provider ??
      (config.embedding ? createEmbeddingProvider(config.embedding) : undefined);
    this.content = new SqliteContentRepository(join(config.dataDir, "content.sqlite"));
    this.vectors = dependencies.vectors;
  }

  private vectorStore(): VectorRepository {
    this.vectors ??= new SqliteVectorRepository(join(this.config.dataDir, "vectors.sqlite"));
    return this.vectors;
  }

  async index(options: { embed?: boolean } = {}): Promise<IndexReport> {
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
      const embedding = await this.synchronizeVectors(options.embed !== false);
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
      const report = await this.synchronizeVectors(true);
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

  private async synchronizeVectors(
    generate: boolean,
  ): Promise<Pick<IndexReport, "embedded" | "reused" | "failed" | "warnings">> {
    const report = { embedded: 0, reused: 0, failed: 0, warnings: [] as string[] };
    const chunks = this.content.listChunks();
    const current = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    let vectors: VectorRepository;
    try {
      vectors = this.vectorStore();
    } catch (error) {
      if (this.provider)
        for (const chunk of chunks) this.content.enqueueEmbedding(chunk, this.provider.profileId);
      report.warnings.push(
        `Vector storage unavailable; text index is ready. ${error instanceof Error ? error.message : ""}`,
      );
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
            "No embedding provider configured. Text index is ready; configure a provider and run embed for semantic search.",
          );
        return report;
      }
      for (const chunk of chunks) {
        if (!vectors.get(provider.profileId, chunk.id, chunk.inputHash))
          this.content.enqueueEmbedding(chunk, provider.profileId);
      }
      // Reconcile cached vectors even with --no-embed: this performs no inference or HTTP calls.
      for (const job of this.content.jobs(provider.profileId)) {
        if (job.operation !== "upsert") continue;
        const cached =
          vectors.get(provider.profileId, job.chunkId, job.inputHash) ??
          vectors.findCached(provider.profileId, job.inputHash);
        if (!cached) continue;
        vectors.upsert(provider.profileId, job.chunkId, job.inputHash, cached);
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
        const uncached = pending.filter((job) => {
          const vector =
            vectors.get(provider.profileId, job.chunkId, job.inputHash) ??
            vectors.findCached(provider.profileId, job.inputHash);
          if (!vector) return true;
          vectors.upsert(provider.profileId, job.chunkId, job.inputHash, vector);
          this.content.completeJob(job.id);
          report.reused++;
          return false;
        });
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
          vectors.ensureProfile(provider.profileId, embeddings[0]!.length, {
            provider: name,
            baseUrl,
            model,
            dimensions,
            documentPrefix,
            queryPrefix,
          });
          const byHash = new Map(inputs.map(([inputHash], i) => [inputHash, embeddings[i]!]));
          for (const job of uncached) {
            vectors.upsert(
              provider.profileId,
              job.chunkId,
              job.inputHash,
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
      for (const entry of vectors.listEntries()) {
        if (!current.has(entry.chunkId)) vectors.removeChunk(entry.chunkId);
      }
      for (const job of this.content.jobs()) {
        if (job.operation !== "delete") continue;
        if (!current.has(job.chunkId)) vectors.removeChunk(job.chunkId);
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
    const response: SearchResponse = { mode, warnings: [], results: [] };
    const candidates = Math.max(30, limit * 3);
    const lexical =
      mode === "vector"
        ? []
        : this.content.searchLexical(searchQuery, candidates, bookId).map(({ chunk }) => chunk);
    let semantic: StoredChunk[] = [];
    if (mode !== "lexical") {
      try {
        if (!this.provider) throw new Error("No embedding provider configured.");
        const vectors = this.vectorStore();
        const eligible = this.content.listChunks(bookId);
        const profileId = this.provider.profileId;
        const indexed = new Map(
          vectors
            .listEntries()
            .filter((entry) => entry.profileId === profileId)
            .map((entry) => [entry.chunkId, entry.inputHash]),
        );
        const current = eligible.filter((chunk) => indexed.get(chunk.id) === chunk.inputHash);
        if (current.length < eligible.length)
          response.warnings.push(
            "Semantic index is incomplete for the current profile. Run embed to update it.",
          );
        if (current.length) {
          const queryVector = (await this.provider.embed([searchQuery], "query"))[0]!;
          const results = vectors.search(
            profileId,
            queryVector,
            candidates,
            current.map(({ id, inputHash }) => ({ chunkId: id, inputHash })),
          );
          semantic = results.flatMap((match) => {
            // Re-read after the HTTP call: an indexer may have changed the source meanwhile.
            const chunk = this.content.getChunk(match.chunkId);
            return chunk?.inputHash === match.inputHash && (!bookId || chunk.bookId === bookId)
              ? [chunk]
              : [];
          });
        } else if (eligible.length) {
          response.warnings.push("No current embeddings found for this profile. Run embed.");
        }
      } catch (error) {
        if (mode === "vector") throw error;
        response.warnings.push(
          `Semantic search unavailable; returning lexical results. ${error instanceof Error ? error.message : ""}`,
        );
      }
    }
    const merged = new Map<string, SearchResult>();
    const add = (list: StoredChunk[], match: "lexical" | "vector") =>
      list.forEach((chunk, rank) => {
        // Search scores are ranks, not confidence probabilities.
        const found = merged.get(chunk.id);
        const contribution = 1 / (60 + rank + 1);
        if (found) {
          found.score += contribution;
          found.matches.push(match);
        } else merged.set(chunk.id, { ...chunk, score: contribution, matches: [match] });
      });
    add(lexical, "lexical");
    add(semantic, "vector");
    const ranked = [...merged.values()].sort(
      (a, b) => b.score - a.score || a.id.localeCompare(b.id),
    );
    // Avoid spending the entire result list on substantially overlapping windows from one passage.
    for (const candidate of ranked) {
      const live = this.content.getChunk(candidate.id);
      if (!live || live.inputHash !== candidate.inputHash) continue;
      const duplicate = response.results.some((prior) => {
        if (prior.documentId !== candidate.documentId) return false;
        const overlap = Math.max(
          0,
          Math.min(prior.endOffset, candidate.endOffset) -
            Math.max(prior.startOffset, candidate.startOffset),
        );
        return (
          overlap /
            Math.min(
              prior.endOffset - prior.startOffset,
              candidate.endOffset - candidate.startOffset,
            ) >
          0.6
        );
      });
      if (!duplicate) response.results.push({ ...candidate, ...live });
      if (response.results.length === limit) break;
    }
    return response;
  }

  status() {
    let vectorStatus: {
      count: number;
      profiles: { id: string; dimensions: number }[];
      error?: string;
    };
    try {
      const vectors = this.vectorStore();
      vectorStatus = { count: vectors.count(), profiles: vectors.listProfiles() };
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

  close(): void {
    try {
      this.vectors?.close();
    } finally {
      this.content.close();
    }
  }
}

export async function initializeLibrary(config: AppConfig): Promise<void> {
  await mkdir(config.booksDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  const library = new BookLibrary(config);
  try {
    const status = library.status();
    if (status.vectors.error) throw new Error(status.vectors.error);
  } finally {
    library.close();
  }
}
