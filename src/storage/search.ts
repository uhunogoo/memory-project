import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { SearchResult, StoredChunk } from "../types.js";
import { z } from "zod";
import { rerankStrategySchema } from "../reranking.js";

export const searchModeSchema = z.enum(["lexical", "vector", "hybrid"]);

const searchOptionsSchema = z.object({
  mode: searchModeSchema.optional(),
  limit: z.number().int().optional(),
  bookId: z.string().optional(),
  rerank: z.boolean().optional(),
  rerankStrategy: rerankStrategySchema.optional(),
});

// Public input structure only; defaults and query/limit policies stay in the library.
export const searchInputSchema = z.object({
  query: z.string(),
  options: searchOptionsSchema,
});

export type SearchMode = z.infer<typeof searchModeSchema>;
export type SearchOptions = z.infer<typeof searchOptionsSchema>;

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  limit: number;
  bookId?: string;
  profileId?: string;
  vector?: number[];
}

export interface SearchResponse {
  mode: SearchMode;
  warnings: string[];
  results: SearchResult[];
}

interface VectorProfile {
  id: string;
  dimensions: number;
}

const SCHEMA_VERSION = 3;
const MAX_DIMENSIONS = 8_192;
const MAX_NEIGHBORS = 4_096;

// Identifiers are always derived here; no provider/model value is interpolated into SQL.
function vectorTable(profileId: string): string {
  return `vec_${createHash("sha256").update(profileId).digest("hex")}`;
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
    throw new Error(`Embedding dimensions must be an integer between 1 and ${MAX_DIMENSIONS}`);
  }
}

function encodeVector(vector: number[], dimensions: number): Uint8Array {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${dimensions}, received ${vector?.length}`,
    );
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Embedding vectors must contain only finite numbers");
  }
  const values = new Float32Array(vector);
  if (!values.every(Number.isFinite)) throw new Error("Embedding values must fit in float32");
  const squaredNorm = Math.fround(values.reduce((sum, value) => sum + value * value, 0));
  if (squaredNorm === 0 || !Number.isFinite(squaredNorm)) {
    throw new Error("Embedding must have a non-zero, finite float32 norm for cosine search");
  }
  return new Uint8Array(values.buffer);
}

function decodeVector(value: Uint8Array): number[] {
  // SQLite may return a view at an unaligned offset, so copy into an aligned buffer.
  return Array.from(new Float32Array(Uint8Array.from(value).buffer));
}

function decodeChunk(row: { payload_json: string }): StoredChunk {
  return JSON.parse(row.payload_json) as StoredChunk;
}

/** Rebuildable search index: payload, lexical retrieval, and vector retrieval live together. */
export class SqliteSearchRepository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `Search database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
      sqliteVec.load(this.db);
      this.db.enableLoadExtension(false);
      this.db.exec("PRAGMA journal_mode = WAL;");
      if (version < SCHEMA_VERSION) this.migrate();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private createVectorTable(profileId: string, dimensions: number): void {
    validateDimensions(dimensions);
    this.db.exec(`CREATE VIRTUAL TABLE ${vectorTable(profileId)} USING vec0(
      embedding float[${dimensions}] distance_metric=cosine, book_id TEXT, active BOOLEAN
    )`);
  }

  private migrate(): void {
    this.transaction(() => {
      // Another connection may have completed initialization while we waited for the lock.
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version === SCHEMA_VERSION) return;
      if (version > SCHEMA_VERSION)
        throw new Error(
          `Search database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      if (version === 1)
        throw new Error(
          "Search schema v1 is no longer supported. Rebuild the search database from content.",
        );
      if (version === 2) {
        this.db.exec(
          "ALTER TABLE embedding_profiles DROP COLUMN metadata_json; ALTER TABLE embedding_profiles DROP COLUMN created_at;",
        );
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        return;
      }
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE embedding_profiles (
            id TEXT PRIMARY KEY,
            dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND ${MAX_DIMENSIONS})
          ) STRICT;
          CREATE TABLE embedding_entries (
            id INTEGER PRIMARY KEY,
            profile_id TEXT NOT NULL REFERENCES embedding_profiles(id),
            chunk_id TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            UNIQUE (profile_id, chunk_id)
          ) STRICT;
          CREATE INDEX embedding_entries_cache ON embedding_entries(profile_id, input_hash);
          CREATE INDEX embedding_entries_chunk ON embedding_entries(chunk_id);
        `);
      }
      this.db.exec(`
        CREATE TABLE search_chunks (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX search_chunks_book ON search_chunks(book_id);
        CREATE VIRTUAL TABLE search_fts USING fts5(
          chunk_id UNINDEXED, title, headings, body, tokenize='unicode61'
        );
      `);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private transaction<T>(action: () => T, readOnly = false): T {
    this.db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private profile(profileId: string): VectorProfile | undefined {
    return this.db
      .prepare("SELECT id, dimensions FROM embedding_profiles WHERE id = ?")
      .get(profileId) as VectorProfile | undefined;
  }

  ensureProfile(profileId: string, dimensions: number): void {
    requireIdentifier(profileId, "Profile ID");
    validateDimensions(dimensions);
    this.transaction(() => {
      const existing = this.profile(profileId);
      if (existing) {
        if (existing.dimensions !== dimensions) {
          throw new Error(
            `Profile ${profileId} has ${existing.dimensions} dimensions, received ${dimensions}; use a new profile for another model`,
          );
        }
        return;
      }
      this.db
        .prepare("INSERT INTO embedding_profiles (id, dimensions) VALUES (?, ?)")
        .run(profileId, dimensions);
      this.createVectorTable(profileId, dimensions);
    });
  }

  private writeChunk(chunk: StoredChunk): void {
    requireIdentifier(chunk.id, "Chunk ID");
    requireIdentifier(chunk.inputHash, "Input hash");
    requireIdentifier(chunk.bookId, "Book ID");
    const payloadJson = JSON.stringify(chunk);
    const existing = this.db
      .prepare("SELECT payload_json FROM search_chunks WHERE id = ?")
      .get(chunk.id) as { payload_json: string } | undefined;
    if (existing?.payload_json === payloadJson) return;
    const row = this.db
      .prepare(`INSERT INTO search_chunks(id, book_id, input_hash, payload_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET book_id=excluded.book_id,
          input_hash=excluded.input_hash, payload_json=excluded.payload_json RETURNING rowid`)
      .get(chunk.id, chunk.bookId, chunk.inputHash, payloadJson)!;
    this.db.prepare("DELETE FROM search_fts WHERE rowid = ?").run(row.rowid);
    this.db
      .prepare(
        "INSERT INTO search_fts(rowid, chunk_id, title, headings, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.rowid, chunk.id, chunk.bookTitle, chunk.headingPath.join(" "), chunk.text);
    const entries = this.db
      .prepare("SELECT id, profile_id, input_hash FROM embedding_entries WHERE chunk_id = ?")
      .all(chunk.id) as { id: number; profile_id: string; input_hash: string }[];
    for (const entry of entries) {
      this.db
        .prepare(
          `UPDATE ${vectorTable(entry.profile_id)} SET book_id = ?, active = ? WHERE rowid = ?`,
        )
        .run(chunk.bookId, entry.input_hash === chunk.inputHash ? 1n : 0n, BigInt(entry.id));
    }
  }

  upsertChunks(chunks: StoredChunk[]): void {
    this.transaction(() => {
      for (const chunk of chunks) this.writeChunk(chunk);
    });
  }

  upsert(profileId: string, chunk: StoredChunk, vector: number[]): void {
    const profile = this.profile(profileId);
    if (!profile) throw new Error(`Unknown embedding profile: ${profileId}`);
    const encoded = encodeVector(vector, profile.dimensions);
    const table = vectorTable(profileId);
    this.transaction(() => {
      this.writeChunk(chunk);
      const existing = this.db
        .prepare("SELECT id FROM embedding_entries WHERE profile_id = ? AND chunk_id = ?")
        .get(profileId, chunk.id) as { id: number } | undefined;
      let id: number | bigint;
      if (existing) {
        id = existing.id;
        this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(id));
        this.db
          .prepare("UPDATE embedding_entries SET input_hash = ? WHERE id = ?")
          .run(chunk.inputHash, id);
      } else {
        id = this.db
          .prepare(
            "INSERT INTO embedding_entries (profile_id, chunk_id, input_hash) VALUES (?, ?, ?)",
          )
          .run(profileId, chunk.id, chunk.inputHash).lastInsertRowid;
      }
      this.db
        .prepare(`INSERT INTO ${table} (rowid, embedding, book_id, active) VALUES (?, ?, ?, 1)`)
        .run(BigInt(id), encoded, chunk.bookId);
    });
  }

  removeChunk(chunkId: string): void {
    this.transaction(() => {
      const entries = this.db
        .prepare("SELECT id, profile_id FROM embedding_entries WHERE chunk_id = ?")
        .all(chunkId) as { id: number; profile_id: string }[];
      for (const entry of entries) {
        this.db
          .prepare(`DELETE FROM ${vectorTable(entry.profile_id)} WHERE rowid = ?`)
          .run(BigInt(entry.id));
      }
      this.db.prepare("DELETE FROM embedding_entries WHERE chunk_id = ?").run(chunkId);
      this.db
        .prepare(
          "DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_chunks WHERE id = ?)",
        )
        .run(chunkId);
      this.db.prepare("DELETE FROM search_chunks WHERE id = ?").run(chunkId);
    });
  }

  get(profileId: string, chunkId: string, inputHash: string): number[] | null {
    const entry = this.db
      .prepare(
        "SELECT id FROM embedding_entries WHERE profile_id = ? AND chunk_id = ? AND input_hash = ?",
      )
      .get(profileId, chunkId, inputHash) as { id: number } | undefined;
    return entry ? this.readVector(profileId, entry.id) : null;
  }

  findCached(profileId: string, inputHash: string): number[] | null {
    const entry = this.db
      .prepare(
        "SELECT id FROM embedding_entries WHERE profile_id = ? AND input_hash = ? ORDER BY id LIMIT 1",
      )
      .get(profileId, inputHash) as { id: number } | undefined;
    return entry ? this.readVector(profileId, entry.id) : null;
  }

  private readVector(profileId: string, id: number): number[] | null {
    const row = this.db
      .prepare(`SELECT embedding FROM ${vectorTable(profileId)} WHERE rowid = ?`)
      .get(BigInt(id)) as { embedding: Uint8Array } | undefined;
    return row ? decodeVector(row.embedding) : null;
  }

  private searchLexical(query: string, limit: number, bookId?: string): StoredChunk[] {
    // User input is always tokenized and quoted, never interpreted as FTS syntax.
    const terms = [...new Set(query.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (terms.length === 0) return [];
    const expression = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = this.db
      .prepare(`SELECT chunks.payload_json FROM search_fts
        JOIN search_chunks AS chunks ON chunks.id = search_fts.chunk_id
        WHERE search_fts MATCH ? ${bookId !== undefined ? "AND chunks.book_id = ?" : ""}
        ORDER BY bm25(search_fts, 0, 3, 2, 1), chunks.id LIMIT ?`)
      .all(expression, ...(bookId !== undefined ? [bookId] : []), limit) as {
      payload_json: string;
    }[];
    return rows.map(decodeChunk);
  }

  private searchVectors(
    profileId: string,
    vector: number[],
    limit: number,
    bookId?: string,
  ): StoredChunk[] {
    const profile = this.profile(profileId);
    if (!profile) return [];
    const encoded = encodeVector(vector, profile.dimensions);
    // Both filters are evaluated by vec0 before selecting k neighbors. Stale
    // embeddings remain cached, but cannot crowd out current searchable entries.
    const rows = this.db
      .prepare(`WITH nearest AS (
        SELECT rowid, distance FROM ${vectorTable(profileId)}
        WHERE embedding MATCH ? AND k = ? AND active = 1
          ${bookId !== undefined ? "AND book_id = ?" : ""}
      )
      SELECT chunks.payload_json FROM nearest
      JOIN embedding_entries AS entries ON entries.id = nearest.rowid
      JOIN search_chunks AS chunks ON chunks.id = entries.chunk_id
      ORDER BY nearest.distance, chunks.id`)
      .all(encoded, BigInt(limit), ...(bookId !== undefined ? [bookId] : [])) as {
      payload_json: string;
    }[];
    return rows.map(decodeChunk);
  }

  search(request: SearchRequest): SearchResponse {
    // A read transaction gives both hybrid branches the same local index snapshot,
    // even when another process commits an indexing batch during retrieval.
    return this.transaction(() => this.searchSnapshot(request), true);
  }

  private searchSnapshot(request: SearchRequest): SearchResponse {
    const { query, mode, limit, bookId, profileId, vector } = request;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEIGHBORS) {
      throw new Error(`Search limit must be an integer between 1 and ${MAX_NEIGHBORS}`);
    }
    const response: SearchResponse = { mode, warnings: [], results: [] };
    const payloadCount = Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM search_chunks").get()!.n,
    );
    if (
      payloadCount === 0 &&
      Number(this.db.prepare("SELECT COUNT(*) AS n FROM embedding_entries").get()!.n) > 0
    ) {
      response.warnings.push(
        "Search payloads are missing. Run index or embed to populate the search index.",
      );
    }
    const candidates = Math.min(MAX_NEIGHBORS, Math.max(30, limit * 3));
    const lexical = mode === "vector" ? [] : this.searchLexical(query, candidates, bookId);
    let semantic: StoredChunk[] = [];
    if (mode !== "lexical") {
      try {
        if (!profileId || !vector)
          throw new Error("An embedding profile and query vector are required.");
        const missing = this.db
          .prepare(`SELECT 1 FROM search_chunks AS chunks WHERE
            ${bookId !== undefined ? "chunks.book_id = ? AND" : ""}
            NOT EXISTS (SELECT 1 FROM embedding_entries AS entries
              WHERE entries.profile_id = ? AND entries.chunk_id = chunks.id
                AND entries.input_hash = chunks.input_hash) LIMIT 1`)
          .get(...(bookId !== undefined ? [bookId] : []), profileId);
        if (missing) {
          response.warnings.push(
            "Semantic index is incomplete for the current profile. Run embed to update it.",
          );
        }
        semantic = this.searchVectors(profileId, vector, candidates, bookId);
        if (missing && semantic.length === 0) {
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
    const add = (chunks: StoredChunk[], match: "lexical" | "vector") => {
      chunks.forEach((chunk, rank) => {
        // Reciprocal rank fusion scores are ranks, not confidence probabilities.
        const contribution = 1 / (60 + rank + 1);
        const found = merged.get(chunk.id);
        if (found) {
          found.score += contribution;
          found.matches.push(match);
        } else {
          merged.set(chunk.id, { ...chunk, score: contribution, matches: [match] });
        }
      });
    };
    add(lexical, "lexical");
    add(semantic, "vector");
    const ranked = [...merged.values()].sort(
      (a, b) => b.score - a.score || a.id.localeCompare(b.id),
    );
    for (const candidate of ranked) {
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
      if (!duplicate) response.results.push(candidate);
      if (response.results.length === limit) break;
    }
    return response;
  }

  count(profileId?: string): number {
    const row =
      profileId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS count FROM embedding_entries").get()
        : this.db
            .prepare("SELECT COUNT(*) AS count FROM embedding_entries WHERE profile_id = ?")
            .get(profileId);
    return Number(row!.count);
  }

  listProfiles(): VectorProfile[] {
    return this.db
      .prepare("SELECT id, dimensions FROM embedding_profiles ORDER BY id")
      .all() as unknown as VectorProfile[];
  }

  listChunkIds(): string[] {
    return this.db
      .prepare(
        "SELECT id FROM search_chunks UNION SELECT chunk_id AS id FROM embedding_entries ORDER BY id",
      )
      .all()
      .map((row) => String(row.id));
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
