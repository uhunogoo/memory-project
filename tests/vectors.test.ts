import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SqliteSearchRepository } from "../src/storage/vectors.js";
import type { IndexedChunk, SearchRequest } from "../src/storage/search.js";

function chunk(id: string, overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id,
    sectionId: `section-${id}`,
    ordinal: 0,
    markdown: `# ${id}\nUseful text about ${id}.`,
    text: `Useful text about ${id}.`,
    embeddingText: `Useful text about ${id}.`,
    contentHash: `content-${id}`,
    inputHash: `hash-${id}`,
    headingPath: ["Chapter", id],
    startOffset: 0,
    endOffset: 100,
    startLine: 1,
    endLine: 5,
    estimatedTokens: 10,
    documentId: `document-${id}`,
    bookId: "book",
    bookTitle: "Example book",
    relativePath: `${id}.md`,
    anchor: id,
    ...overrides,
  };
}

const vectorRequest = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  query: "text",
  mode: "vector",
  profileId: "model",
  vector: [1, 0],
  limit: 5,
  ...overrides,
});

describe("SqliteSearchRepository", () => {
  let directory: string;
  let path: string;
  let repository: SqliteSearchRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "book-search-"));
    path = join(directory, "vectors.sqlite");
    repository = new SqliteSearchRepository(path);
  });

  afterEach(async () => {
    await repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reopens complete searchable payloads and embeddings without a content database", async () => {
    const original = chunk("chapter-1");
    await repository.ensureProfile("ollama/model", 3, { model: "model", provider: "ollama" });
    await repository.upsert("ollama/model", original, [1, 0.5, 0]);
    await repository.close();
    repository = new SqliteSearchRepository(path);
    expect(await repository.listProfiles()).toEqual([{ id: "ollama/model", dimensions: 3 }]);
    expect(await repository.get("ollama/model", original.id, original.inputHash)).toEqual([
      1, 0.5, 0,
    ]);
    expect(await repository.get("ollama/model", original.id, "stale")).toBeNull();
    expect(await repository.count()).toBe(1);
    expect(await repository.listEntries()).toEqual([
      { chunkId: original.id, inputHash: original.inputHash, profileId: "ollama/model" },
    ]);
    expect(await repository.listChunkIds()).toEqual([original.id]);
    const response = await repository.search(
      vectorRequest({ profileId: "ollama/model", vector: [1, 0.5, 0] }),
    );
    expect(response.results).toEqual([{ ...original, score: 1 / 61, matches: ["vector"] }]);
    const lexical = await repository.search({ query: "Useful", mode: "lexical", limit: 1 });
    expect(lexical.results[0]).toMatchObject(original);
  });

  it("searches payloads lexically before any embedding profile exists", async () => {
    const original = chunk("lexical", { text: "Векторний пошук українського тексту" });
    await repository.upsertChunks([original]);
    const response = await repository.search({ query: "українського", mode: "lexical", limit: 5 });
    expect(response).toEqual({
      mode: "lexical",
      warnings: [],
      results: [{ ...original, score: 1 / 61, matches: ["lexical"] }],
    });
    expect(await repository.count()).toBe(0);
    expect(
      (await repository.search({ query: '" OR NEAR(*)', mode: "lexical", limit: 5 })).results,
    ).toEqual([]);
    expect((await repository.search({ query: "---", mode: "lexical", limit: 5 })).results).toEqual(
      [],
    );
  });

  it("uses cosine nearest neighbors, including unnormalized embeddings", async () => {
    await repository.ensureProfile("model", 2, {});
    await repository.upsert("model", chunk("east"), [100, 0]);
    await repository.upsert("model", chunk("north"), [0, 1]);
    await repository.upsert("model", chunk("west"), [-1, 0]);
    const response = await repository.search(vectorRequest({ limit: 3 }));
    expect(response.results.map((result) => result.id)).toEqual(["east", "north", "west"]);
    expect(response.results.map((result) => result.score)).toEqual([1 / 61, 1 / 62, 1 / 63]);
    expect((await repository.search(vectorRequest({ limit: 1 }))).results).toEqual([
      response.results[0],
    ]);
    expect((await repository.search(vectorRequest({ profileId: "unknown" }))).results).toEqual([]);
  });

  it("keeps profiles isolated and accepts safely quoted arbitrary profile names", async () => {
    const unusual = "model'); DROP TABLE embedding_profiles; --";
    const original = chunk("same-chunk");
    await repository.ensureProfile(unusual, 2, {});
    await repository.ensureProfile("other", 3, {});
    await repository.upsert(unusual, original, [1, 0]);
    await repository.upsert("other", original, [0, 1, 0]);
    expect(await repository.count()).toBe(2);
    expect(await repository.count(unusual)).toBe(1);
    expect(await repository.get("other", original.id, original.inputHash)).toEqual([0, 1, 0]);
    expect((await repository.search(vectorRequest({ profileId: unusual }))).results).toHaveLength(
      1,
    );
    expect(await repository.findCached("missing", original.inputHash)).toBeNull();
    expect(await repository.findCached(unusual, original.inputHash)).toEqual([1, 0]);
  });

  it("filters books and inactive embeddings inside KNN before limiting candidates", async () => {
    await repository.ensureProfile("model", 2, {});
    for (let index = 0; index < 35; index++) {
      await repository.upsert("model", chunk(`other-${index}`, { bookId: "other" }), [1, 0]);
      const stale = chunk(`stale-${index}`, { bookId: "target" });
      await repository.upsert("model", stale, [1, 0]);
      await repository.upsertChunks([{ ...stale, inputHash: `updated-${index}` }]);
    }
    const current = chunk("current", { bookId: "target", text: "uniquekeyword" });
    await repository.upsert("model", current, [0, 1]);
    const response = await repository.search(vectorRequest({ bookId: "target", limit: 1 }));
    expect(response.results.map((result) => result.id)).toEqual([current.id]);
    expect(response.warnings).toEqual([
      "Semantic index is incomplete for the current profile. Run embed to update it.",
    ]);
    const hybrid = await repository.search(
      vectorRequest({ query: "uniquekeyword", mode: "hybrid", bookId: "target", limit: 1 }),
    );
    expect(hybrid.results).toEqual([{ ...current, score: 2 / 61, matches: ["lexical", "vector"] }]);
    expect((await repository.search(vectorRequest({ bookId: "missing" }))).results).toEqual([]);
    expect((await repository.search(vectorRequest({ bookId: "other" }))).warnings).toEqual([]);
  });

  it("refreshes metadata and lexical text in every profile without regenerating vectors", async () => {
    await repository.ensureProfile("a", 2, {});
    await repository.ensureProfile("b", 3, {});
    const before = chunk("moving", { text: "oldword" });
    await repository.upsert("a", before, [1, 0]);
    await repository.upsert("b", before, [1, 0, 0]);
    const after = {
      ...before,
      bookId: "new-book",
      bookTitle: "New title",
      text: "newword",
      relativePath: "new/path.md",
      startLine: 20,
      endLine: 25,
    };
    await repository.upsertChunks([after]);
    for (const [profileId, vector] of [
      ["a", [1, 0]],
      ["b", [1, 0, 0]],
    ] as const) {
      expect(
        (await repository.search(vectorRequest({ profileId, vector: [...vector], bookId: "book" })))
          .results,
      ).toEqual([]);
      const response = await repository.search(
        vectorRequest({ profileId, vector: [...vector], bookId: "new-book" }),
      );
      expect(response.results[0]).toMatchObject(after);
      expect(response.warnings).toEqual([]);
    }
    expect(await repository.get("a", before.id, before.inputHash)).toEqual([1, 0]);
    expect(
      (await repository.search({ query: "oldword", mode: "lexical", limit: 5 })).results,
    ).toEqual([]);
    expect(
      (await repository.search({ query: "newword", mode: "lexical", limit: 5, bookId: "new-book" }))
        .results[0],
    ).toMatchObject(after);
  });

  it("retains stale embeddings for reuse while excluding them from semantic results", async () => {
    await repository.ensureProfile("model", 2, {});
    const before = chunk("changed");
    await repository.upsert("model", before, [1, 0]);
    const after = { ...before, inputHash: "new-input", text: "replacement" };
    await repository.upsertChunks([after]);
    expect(await repository.findCached("model", before.inputHash)).toEqual([1, 0]);
    expect((await repository.search(vectorRequest())).results).toEqual([]);
    expect(
      (await repository.search({ query: "replacement", mode: "lexical", limit: 5 })).results[0],
    ).toMatchObject(after);
    // Returning to the same input activates the existing cached vector.
    await repository.upsertChunks([before]);
    expect((await repository.search(vectorRequest())).results[0]).toMatchObject(before);
  });

  it("retries upserts idempotently and replaces obsolete hashes in the cache", async () => {
    await repository.ensureProfile("model", 2, {});
    await repository.upsert("model", chunk("chunk", { inputHash: "before" }), [1, 0]);
    const after = chunk("chunk", { inputHash: "after", text: "replacement" });
    await repository.upsert("model", after, [0, 1]);
    await repository.upsert("model", after, [0, 1]);
    expect(await repository.count()).toBe(1);
    expect(await repository.get("model", "chunk", "before")).toBeNull();
    expect(await repository.findCached("model", "before")).toBeNull();
    expect(await repository.findCached("model", "after")).toEqual([0, 1]);
    const response = await repository.search(
      vectorRequest({ vector: [0, 1], mode: "hybrid", query: "replacement" }),
    );
    expect(response.results).toEqual([{ ...after, score: 2 / 61, matches: ["lexical", "vector"] }]);
  });

  it("rolls back payload, FTS and vector changes together if entry update fails", async () => {
    await repository.ensureProfile("model", 2, {});
    const before = chunk("chunk", { inputHash: "before", text: "originalword" });
    await repository.upsert("model", before, [1, 0]);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER simulate_failure BEFORE UPDATE ON embedding_entries
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    raw.close();
    await expect(
      repository.upsert("model", { ...before, inputHash: "after", text: "replacement" }, [0, 1]),
    ).rejects.toThrow(/simulated/);
    expect(await repository.get("model", "chunk", "before")).toEqual([1, 0]);
    const response = await repository.search(
      vectorRequest({ mode: "hybrid", query: "originalword" }),
    );
    expect(response.results).toEqual([
      { ...before, score: 2 / 61, matches: ["lexical", "vector"] },
    ]);
    expect(
      (await repository.search({ query: "replacement", mode: "lexical", limit: 5 })).results,
    ).toEqual([]);
  });

  it("rolls back an entire payload batch on failure", async () => {
    await expect(
      repository.upsertChunks([chunk("valid"), chunk("bad", { inputHash: "" })]),
    ).rejects.toThrow(/Input hash/);
    expect(await repository.listChunkIds()).toEqual([]);
    expect(
      (await repository.search({ query: "valid", mode: "lexical", limit: 5 })).results,
    ).toEqual([]);
  });

  it("deletes payloads, FTS and every profile idempotently while retaining other cache entries", async () => {
    await repository.ensureProfile("a", 2, {});
    await repository.ensureProfile("b", 3, {});
    const remove = chunk("remove", { inputHash: "shared", text: "removedword" });
    await repository.upsert("a", remove, [1, 0]);
    await repository.upsert("b", remove, [1, 0, 0]);
    await repository.upsert("a", chunk("keep", { inputHash: "shared" }), [1, 0]);
    await repository.upsertChunks([chunk("only-text", { text: "removedword" })]);
    await repository.removeChunk("remove");
    await repository.removeChunk("remove");
    await repository.removeChunk("only-text");
    expect(await repository.count()).toBe(1);
    expect(await repository.listChunkIds()).toEqual(["keep"]);
    expect(
      (await repository.search(vectorRequest({ profileId: "b", vector: [1, 0, 0] }))).results,
    ).toEqual([]);
    expect(
      (await repository.search(vectorRequest({ profileId: "a" }))).results.map(
        (result) => result.id,
      ),
    ).toEqual(["keep"]);
    expect(
      (await repository.search({ query: "removedword", mode: "lexical", limit: 5 })).results,
    ).toEqual([]);
    expect(await repository.findCached("a", "shared")).toEqual([1, 0]);
  });

  it("rolls back deletion from all indexes if payload deletion fails", async () => {
    await repository.ensureProfile("model", 2, {});
    const original = chunk("rollback");
    await repository.upsert("model", original, [1, 0]);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER simulate_failure BEFORE DELETE ON search_chunks
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;`);
    raw.close();
    await expect(repository.removeChunk(original.id)).rejects.toThrow(/simulated/);
    expect(await repository.get("model", original.id, original.inputHash)).toEqual([1, 0]);
    expect(
      (await repository.search(vectorRequest({ mode: "hybrid", query: "rollback" }))).results[0]
        ?.matches,
    ).toEqual(["lexical", "vector"]);
  });

  it("fuses ranks and suppresses overlapping passages using indexed coordinates", async () => {
    await repository.ensureProfile("model", 2, {});
    const first = chunk("a", {
      documentId: "shared",
      text: "needle",
      startOffset: 0,
      endOffset: 100,
    });
    const overlapping = chunk("b", {
      documentId: "shared",
      text: "needle",
      startOffset: 20,
      endOffset: 120,
    });
    const separate = chunk("c", {
      documentId: "shared",
      text: "other",
      startOffset: 200,
      endOffset: 300,
    });
    await repository.upsert("model", first, [1, 0]);
    await repository.upsert("model", overlapping, [0.9, 0.1]);
    await repository.upsert("model", separate, [0, 1]);
    const response = await repository.search(vectorRequest({ query: "needle", mode: "hybrid" }));
    expect(response.results.map((result) => result.id)).toEqual(["a", "c"]);
    expect(response.results[0]?.matches).toEqual(["lexical", "vector"]);
    expect(response.results[0]?.score).toBe(2 / 61);
    expect(response.results[1]?.matches).toEqual(["vector"]);
  });

  it("falls back to lexical results for unavailable hybrid vectors", async () => {
    await repository.upsertChunks([chunk("lexical")]);
    const response = await repository.search({ query: "Useful", mode: "hybrid", limit: 5 });
    expect(response.results[0]?.matches).toEqual(["lexical"]);
    expect(response.warnings[0]).toMatch(/Semantic search unavailable/);
    await expect(repository.search({ query: "Useful", mode: "vector", limit: 5 })).rejects.toThrow(
      /profile/,
    );
  });

  it("rejects invalid dimensions and vectors without changing existing data", async () => {
    await repository.ensureProfile("model", 2, {});
    await repository.ensureProfile("model", 2, {});
    await expect(repository.ensureProfile("model", 3, {})).rejects.toThrow(/dimensions/);
    for (const dimensions of [0, 8193, 1.5]) {
      await expect(repository.ensureProfile("bad", dimensions, {})).rejects.toThrow(/dimensions/);
    }
    await repository.upsert("model", chunk("chunk", { inputHash: "good" }), [1, 0]);
    for (const vector of [[1], [NaN, 1], [Infinity, 1], [0, 0], [1e100, 0], [1e-100, 0]]) {
      await expect(
        repository.upsert("model", chunk("chunk", { inputHash: "bad" }), vector),
      ).rejects.toThrow();
      await expect(repository.search(vectorRequest({ vector }))).rejects.toThrow();
    }
    await expect(repository.upsert("missing", chunk("chunk"), [1, 0])).rejects.toThrow(/Unknown/);
    await expect(repository.search(vectorRequest({ limit: 0 }))).rejects.toThrow(/limit/);
    expect(await repository.get("model", "chunk", "good")).toEqual([1, 0]);
    expect(await repository.count()).toBe(1);
  });

  it("migrates v1 vector caches and activates them only after payload synchronization", async () => {
    await repository.close();
    path = join(directory, "legacy.sqlite");
    const table = `vec_${createHash("sha256").update("model").digest("hex")}`;
    const raw = new DatabaseSync(path, { allowExtension: true });
    sqliteVec.load(raw);
    raw.exec(`
      CREATE TABLE embedding_profiles(id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, metadata_json TEXT NOT NULL) STRICT;
      CREATE TABLE embedding_entries(id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES embedding_profiles(id), chunk_id TEXT NOT NULL, input_hash TEXT NOT NULL, UNIQUE(profile_id, chunk_id)) STRICT;
      CREATE INDEX embedding_entries_cache ON embedding_entries(profile_id, input_hash);
      CREATE INDEX embedding_entries_chunk ON embedding_entries(chunk_id);
      INSERT INTO embedding_profiles VALUES ('model', 2, '{}');
      INSERT INTO embedding_entries VALUES (1, 'model', 'legacy', 'hash-legacy');
      CREATE VIRTUAL TABLE ${table} USING vec0(embedding float[2] distance_metric=cosine);
      PRAGMA user_version = 1;
    `);
    raw
      .prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`)
      .run(1n, new Uint8Array(new Float32Array([1, 0]).buffer));
    raw.close();
    repository = new SqliteSearchRepository(path);
    expect(await repository.count()).toBe(1);
    expect(await repository.listProfiles()).toEqual([{ id: "model", dimensions: 2 }]);
    expect(await repository.findCached("model", "hash-legacy")).toEqual([1, 0]);
    const before = await repository.search(vectorRequest());
    expect(before.results).toEqual([]);
    expect(before.warnings).toEqual([
      "Search payloads are missing. Run index or embed to populate the search index.",
    ]);
    await repository.upsertChunks([chunk("legacy")]);
    const after = await repository.search(
      vectorRequest({ mode: "hybrid", query: "legacy", bookId: "book" }),
    );
    expect(after.warnings).toEqual([]);
    expect(after.results[0]).toMatchObject({ ...chunk("legacy"), matches: ["lexical", "vector"] });
    await repository.close();
    repository = new SqliteSearchRepository(path);
    expect((await repository.search(vectorRequest())).results[0]?.id).toBe("legacy");
  });

  it("refuses to open a database created by a newer schema", async () => {
    await repository.close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteSearchRepository(path)).toThrow(/newer/);
  });
});
