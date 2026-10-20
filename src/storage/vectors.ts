import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export interface VectorMatch {
  chunkId: string;
  inputHash: string;
  distance: number;
}

export interface VectorEntry {
  chunkId: string;
  inputHash: string;
  profileId: string;
}

export interface VectorProfile {
  id: string;
  dimensions: number;
}

export interface EligibleVector {
  chunkId: string;
  inputHash: string;
}

/** This contract contains no SQLite types, so another vector service can implement it. */
export interface VectorRepository {
  ensureProfile(profileId: string, dimensions: number, metadata: Record<string, unknown>): void;
  upsert(profileId: string, chunkId: string, inputHash: string, vector: number[]): void;
  removeChunk(chunkId: string): void;
  get(profileId: string, chunkId: string, inputHash: string): number[] | null;
  findCached(profileId: string, inputHash: string): number[] | null;
  search(
    profileId: string,
    vector: number[],
    limit: number,
    eligible?: EligibleVector[],
  ): VectorMatch[];
  count(profileId?: string): number;
  listProfiles(): VectorProfile[];
  listEntries(): VectorEntry[];
  close(): void;
}

const SCHEMA_VERSION = 1;
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
  if (!values.every(Number.isFinite)) {
    throw new Error("Embedding values must fit in float32");
  }
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

/** Derived vector index. The content database owns source text and retryable jobs. */
export class SqliteVectorRepository implements VectorRepository {
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
          `Vector database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
      sqliteVec.load(this.db);
      this.db.enableLoadExtension(false);
      this.db.exec("PRAGMA journal_mode = WAL;");
      if (version === 0) this.migrate();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      // Another connection may have completed initialization while we waited for the lock.
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version === SCHEMA_VERSION) return;
      if (version > SCHEMA_VERSION)
        throw new Error(
          `Vector database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      this.db.exec(`
        CREATE TABLE embedding_profiles (
          id TEXT PRIMARY KEY,
          dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND ${MAX_DIMENSIONS}),
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
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

  ensureProfile(profileId: string, dimensions: number, metadata: Record<string, unknown>): void {
    requireIdentifier(profileId, "Profile ID");
    validateDimensions(dimensions);
    const metadataJson = JSON.stringify(metadata);
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
        .prepare("INSERT INTO embedding_profiles (id, dimensions, metadata_json) VALUES (?, ?, ?)")
        .run(profileId, dimensions, metadataJson);
      this.db.exec(
        `CREATE VIRTUAL TABLE ${vectorTable(profileId)} USING vec0(embedding float[${dimensions}] distance_metric=cosine)`,
      );
    });
  }

  upsert(profileId: string, chunkId: string, inputHash: string, vector: number[]): void {
    requireIdentifier(chunkId, "Chunk ID");
    requireIdentifier(inputHash, "Input hash");
    const profile = this.profile(profileId);
    if (!profile) throw new Error(`Unknown embedding profile: ${profileId}`);
    const encoded = encodeVector(vector, profile.dimensions);
    const table = vectorTable(profileId);
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM embedding_entries WHERE profile_id = ? AND chunk_id = ?")
        .get(profileId, chunkId) as { id: number } | undefined;
      let id: number | bigint;
      if (existing) {
        id = existing.id;
        this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(id));
        this.db
          .prepare("UPDATE embedding_entries SET input_hash = ? WHERE id = ?")
          .run(inputHash, id);
      } else {
        id = this.db
          .prepare(
            "INSERT INTO embedding_entries (profile_id, chunk_id, input_hash) VALUES (?, ?, ?)",
          )
          .run(profileId, chunkId, inputHash).lastInsertRowid;
      }
      this.db
        .prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`)
        .run(BigInt(id), encoded);
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

  search(
    profileId: string,
    vector: number[],
    limit: number,
    eligible?: EligibleVector[],
  ): VectorMatch[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEIGHBORS) {
      throw new Error(`Vector search limit must be an integer between 1 and ${MAX_NEIGHBORS}`);
    }
    const profile = this.profile(profileId);
    if (!profile) return [];
    const encoded = encodeVector(vector, profile.dimensions);
    if (eligible) {
      if (eligible.length === 0) return [];
      // Apply book/version eligibility before ranking, so stale vectors cannot crowd out
      // current matches. Exact cosine over this subset is suitable for a small library.
      // json_each avoids SQLite's parameter limit without connection-local mutable state.
      const rows = this.db
        .prepare(`
        WITH eligible AS (
          SELECT DISTINCT json_extract(value, '$.chunkId') AS chunk_id,
            json_extract(value, '$.inputHash') AS input_hash FROM json_each(?)
        )
        SELECT entries.chunk_id AS chunkId, entries.input_hash AS inputHash,
          vec_distance_cosine(vectors.embedding, ?) AS distance
        FROM eligible
        JOIN embedding_entries AS entries
          ON entries.chunk_id = eligible.chunk_id AND entries.input_hash = eligible.input_hash
        JOIN ${vectorTable(profileId)} AS vectors ON vectors.rowid = entries.id
        WHERE entries.profile_id = ?
        ORDER BY distance, entries.chunk_id
        LIMIT ?
      `)
        .all(
          JSON.stringify(eligible),
          encoded,
          profileId,
          BigInt(limit),
        ) as unknown as VectorMatch[];
      return rows.map((row) => ({ ...row }));
    }
    const rows = this.db
      .prepare(`
      WITH nearest AS (
        SELECT rowid, distance FROM ${vectorTable(profileId)}
        WHERE embedding MATCH ? AND k = ?
      )
      SELECT entries.chunk_id AS chunkId, entries.input_hash AS inputHash, nearest.distance
      FROM nearest JOIN embedding_entries AS entries ON entries.id = nearest.rowid
      WHERE entries.profile_id = ?
      ORDER BY nearest.distance, entries.chunk_id
    `)
      .all(encoded, BigInt(limit), profileId) as unknown as VectorMatch[];
    return rows.map((row) => ({ ...row }));
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

  listEntries(): VectorEntry[] {
    return this.db
      .prepare(`
      SELECT chunk_id AS chunkId, input_hash AS inputHash, profile_id AS profileId
      FROM embedding_entries ORDER BY profile_id, chunk_id
    `)
      .all() as unknown as VectorEntry[];
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
