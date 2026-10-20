import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SqliteVectorRepository } from "../src/storage/vectors.js";

describe("SqliteVectorRepository", () => {
  let directory: string;
  let path: string;
  let repository: SqliteVectorRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "book-vectors-"));
    path = join(directory, "vectors.sqlite");
    repository = new SqliteVectorRepository(path);
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists profiles, exact input hashes, and float32 embeddings across restarts", () => {
    repository.ensureProfile("ollama/model", 3, { model: "model", provider: "ollama" });
    repository.upsert("ollama/model", "chapter-1", "hash-1", [1, 0.5, 0]);
    repository.close();
    repository = new SqliteVectorRepository(path);
    expect(repository.listProfiles()).toEqual([{ id: "ollama/model", dimensions: 3 }]);
    expect(repository.get("ollama/model", "chapter-1", "hash-1")).toEqual([1, 0.5, 0]);
    expect(repository.get("ollama/model", "chapter-1", "stale")).toBeNull();
    expect(repository.count()).toBe(1);
    expect(repository.listEntries()).toEqual([
      { chunkId: "chapter-1", inputHash: "hash-1", profileId: "ollama/model" },
    ]);
  });

  it("uses cosine nearest neighbors, including unnormalized embeddings", () => {
    repository.ensureProfile("model", 2, {});
    repository.upsert("model", "east", "a", [100, 0]);
    repository.upsert("model", "north", "b", [0, 1]);
    repository.upsert("model", "west", "c", [-1, 0]);
    const results = repository.search("model", [1, 0], 3);
    expect(results.map((result) => result.chunkId)).toEqual(["east", "north", "west"]);
    expect(results.map((result) => result.distance)).toEqual([0, 1, 2]);
    expect(repository.search("model", [1, 0], 1)).toEqual([results[0]]);
    expect(repository.search("unknown", [1, 0], 1)).toEqual([]);
  });

  it("keeps profiles isolated and allows safely quoted arbitrary profile names", () => {
    const unusual = "model'); DROP TABLE embedding_profiles; --";
    repository.ensureProfile(unusual, 2, {});
    repository.ensureProfile("other", 3, {});
    repository.upsert(unusual, "same-chunk", "same-hash", [1, 0]);
    repository.upsert("other", "same-chunk", "same-hash", [0, 1, 0]);
    expect(repository.count()).toBe(2);
    expect(repository.count(unusual)).toBe(1);
    expect(repository.get("other", "same-chunk", "same-hash")).toEqual([0, 1, 0]);
    expect(repository.search(unusual, [1, 0], 5)).toHaveLength(1);
    expect(repository.findCached("missing", "same-hash")).toBeNull();
    expect(repository.findCached(unusual, "same-hash")).toEqual([1, 0]);
  });

  it("filters current hashes and book membership before applying the nearest-neighbor limit", () => {
    repository.ensureProfile("model", 2, {});
    repository.upsert("model", "other-book", "valid", [1, 0]);
    repository.upsert("model", "stale-chunk", "old", [1, 0]);
    repository.upsert("model", "current-chunk", "current", [0, 1]);
    const eligible = [
      { chunkId: "stale-chunk", inputHash: "new" },
      { chunkId: "current-chunk", inputHash: "current" },
      { chunkId: "current-chunk", inputHash: "current" },
    ];
    expect(repository.search("model", [1, 0], 1, eligible)).toEqual([
      { chunkId: "current-chunk", inputHash: "current", distance: 1 },
    ]);
    expect(repository.search("model", [1, 0], 1, [])).toEqual([]);
    expect(
      repository.search("model", [1, 0], 1, [{ chunkId: "missing", inputHash: "hash" }]),
    ).toEqual([]);
  });

  it("retries updates idempotently and removes obsolete hashes from the cache", () => {
    repository.ensureProfile("model", 2, {});
    repository.upsert("model", "chunk", "before", [1, 0]);
    repository.upsert("model", "chunk", "after", [0, 1]);
    repository.upsert("model", "chunk", "after", [0, 1]);
    expect(repository.count()).toBe(1);
    expect(repository.get("model", "chunk", "before")).toBeNull();
    expect(repository.findCached("model", "before")).toBeNull();
    expect(repository.findCached("model", "after")).toEqual([0, 1]);
    expect(repository.search("model", [0, 1], 5)[0]?.distance).toBe(0);
  });

  it("rolls back vector deletion if the matching metadata update fails", () => {
    repository.ensureProfile("model", 2, {});
    repository.upsert("model", "chunk", "before", [1, 0]);
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER simulate_failure BEFORE UPDATE ON embedding_entries
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
    `);
    raw.close();
    expect(() => repository.upsert("model", "chunk", "after", [0, 1])).toThrow(/simulated/);
    expect(repository.get("model", "chunk", "before")).toEqual([1, 0]);
    expect(repository.search("model", [1, 0], 1)).toEqual([
      { chunkId: "chunk", inputHash: "before", distance: 0 },
    ]);
  });

  it("deletes a chunk in every profile while retaining other cached entries", () => {
    repository.ensureProfile("a", 2, {});
    repository.ensureProfile("b", 3, {});
    repository.upsert("a", "remove", "shared", [1, 0]);
    repository.upsert("b", "remove", "shared", [1, 0, 0]);
    repository.upsert("a", "keep", "shared", [1, 0]);
    repository.removeChunk("remove");
    repository.removeChunk("remove");
    expect(repository.count()).toBe(1);
    expect(repository.search("b", [1, 0, 0], 5)).toEqual([]);
    expect(repository.search("a", [1, 0], 5).map((result) => result.chunkId)).toEqual(["keep"]);
    expect(repository.findCached("a", "shared")).toEqual([1, 0]);
  });

  it("rejects mismatched dimensions and invalid vectors without changing existing data", () => {
    repository.ensureProfile("model", 2, {});
    repository.ensureProfile("model", 2, {});
    expect(() => repository.ensureProfile("model", 3, {})).toThrow(/dimensions/);
    expect(() => repository.ensureProfile("bad", 0, {})).toThrow(/dimensions/);
    expect(() => repository.ensureProfile("bad", 8193, {})).toThrow(/dimensions/);
    expect(() => repository.ensureProfile("bad", 1.5, {})).toThrow(/dimensions/);
    repository.upsert("model", "chunk", "good", [1, 0]);
    for (const vector of [[1], [NaN, 1], [Infinity, 1], [0, 0], [1e100, 0], [1e-100, 0]]) {
      expect(() => repository.upsert("model", "chunk", "bad", vector)).toThrow();
      expect(() => repository.search("model", vector, 2)).toThrow();
    }
    expect(() => repository.upsert("missing", "chunk", "hash", [1, 0])).toThrow(/Unknown/);
    expect(() => repository.search("model", [1, 0], 0)).toThrow(/limit/);
    expect(repository.get("model", "chunk", "good")).toEqual([1, 0]);
    expect(repository.count()).toBe(1);
  });

  it("refuses to open a database created by a newer schema", () => {
    repository.close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteVectorRepository(path)).toThrow(/newer/);
  });
});
