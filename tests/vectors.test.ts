import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SqliteSearchRepository } from "../src/storage/search.js";
import type { SearchRequest } from "../src/storage/search.js";
import type { StoredChunk } from "../src/types.js";

function chunk(id: string, overrides: Partial<StoredChunk> = {}): StoredChunk {
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

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reopens complete searchable payloads and embeddings without a content database", () => {
    const original = chunk("chapter-1");
    repository.ensureProfile("ollama/model", 3);
    repository.upsert("ollama/model", original, [1, 0.5, 0]);
    repository.close();
    repository = new SqliteSearchRepository(path);
    expect(repository.listProfiles()).toEqual([{ id: "ollama/model", dimensions: 3 }]);
    expect(repository.get("ollama/model", original.id, original.inputHash)).toEqual([1, 0.5, 0]);
    expect(repository.get("ollama/model", original.id, "stale")).toBeNull();
    expect(repository.count()).toBe(1);
    expect(repository.listChunkIds()).toEqual([original.id]);
    const response = repository.search(
      vectorRequest({ profileId: "ollama/model", vector: [1, 0.5, 0] }),
    );
    expect(response.results).toEqual([{ ...original, score: 1 / 61, matches: ["vector"] }]);
    const lexical = repository.search({ query: "Useful", mode: "lexical", limit: 1 });
    expect(lexical.results[0]).toMatchObject(original);
  });

  it("searches payloads lexically before any embedding profile exists", () => {
    const original = chunk("lexical", { text: "Векторний пошук українського тексту" });
    repository.upsertChunks([original]);
    const response = repository.search({ query: "українського", mode: "lexical", limit: 5 });
    expect(response).toEqual({
      mode: "lexical",
      warnings: [],
      results: [{ ...original, score: 1 / 61, matches: ["lexical"] }],
    });
    expect(repository.count()).toBe(0);
    expect(repository.search({ query: '" OR NEAR(*)', mode: "lexical", limit: 5 }).results).toEqual(
      [],
    );
    expect(repository.search({ query: "---", mode: "lexical", limit: 5 }).results).toEqual([]);
  });

  it("uses cosine nearest neighbors, including unnormalized embeddings", () => {
    repository.ensureProfile("model", 2);
    repository.upsert("model", chunk("east"), [100, 0]);
    repository.upsert("model", chunk("north"), [0, 1]);
    repository.upsert("model", chunk("west"), [-1, 0]);
    const response = repository.search(vectorRequest({ limit: 3 }));
    expect(response.results.map((result) => result.id)).toEqual(["east", "north", "west"]);
    expect(response.results.map((result) => result.score)).toEqual([1 / 61, 1 / 62, 1 / 63]);
    expect(repository.search(vectorRequest({ limit: 1 })).results).toEqual([response.results[0]]);
    expect(repository.search(vectorRequest({ profileId: "unknown" })).results).toEqual([]);
  });

  it("keeps profiles isolated and accepts safely quoted arbitrary profile names", () => {
    const unusual = "model'); DROP TABLE embedding_profiles; --";
    const original = chunk("same-chunk");
    repository.ensureProfile(unusual, 2);
    repository.ensureProfile("other", 3);
    repository.upsert(unusual, original, [1, 0]);
    repository.upsert("other", original, [0, 1, 0]);
    expect(repository.count()).toBe(2);
    expect(repository.count(unusual)).toBe(1);
    expect(repository.get("other", original.id, original.inputHash)).toEqual([0, 1, 0]);
    expect(repository.search(vectorRequest({ profileId: unusual })).results).toHaveLength(1);
    expect(repository.findCached("missing", original.inputHash)).toBeNull();
    expect(repository.findCached(unusual, original.inputHash)).toEqual([1, 0]);
  });

  it("filters books and inactive embeddings inside KNN before limiting candidates", () => {
    repository.ensureProfile("model", 2);
    for (let index = 0; index < 35; index++) {
      repository.upsert("model", chunk(`other-${index}`, { bookId: "other" }), [1, 0]);
      const stale = chunk(`stale-${index}`, { bookId: "target" });
      repository.upsert("model", stale, [1, 0]);
      repository.upsertChunks([{ ...stale, inputHash: `updated-${index}` }]);
    }
    const current = chunk("current", { bookId: "target", text: "uniquekeyword" });
    repository.upsert("model", current, [0, 1]);
    const response = repository.search(vectorRequest({ bookId: "target", limit: 1 }));
    expect(response.results.map((result) => result.id)).toEqual([current.id]);
    expect(response.warnings).toEqual([
      "Semantic index is incomplete for the current profile. Run embed to update it.",
    ]);
    const hybrid = repository.search(
      vectorRequest({ query: "uniquekeyword", mode: "hybrid", bookId: "target", limit: 1 }),
    );
    expect(hybrid.results).toEqual([{ ...current, score: 2 / 61, matches: ["lexical", "vector"] }]);
    expect(repository.search(vectorRequest({ bookId: "missing" })).results).toEqual([]);
    expect(repository.search(vectorRequest({ bookId: "other" })).warnings).toEqual([]);
  });

  it("refreshes metadata and lexical text in every profile without regenerating vectors", () => {
    repository.ensureProfile("a", 2);
    repository.ensureProfile("b", 3);
    const before = chunk("moving", { text: "oldword" });
    repository.upsert("a", before, [1, 0]);
    repository.upsert("b", before, [1, 0, 0]);
    const after = {
      ...before,
      bookId: "new-book",
      bookTitle: "New title",
      text: "newword",
      relativePath: "new/path.md",
      startLine: 20,
      endLine: 25,
    };
    repository.upsertChunks([after]);
    for (const [profileId, vector] of [
      ["a", [1, 0]],
      ["b", [1, 0, 0]],
    ] as const) {
      expect(
        repository.search(vectorRequest({ profileId, vector: [...vector], bookId: "book" }))
          .results,
      ).toEqual([]);
      const response = repository.search(
        vectorRequest({ profileId, vector: [...vector], bookId: "new-book" }),
      );
      expect(response.results[0]).toMatchObject(after);
      expect(response.warnings).toEqual([]);
    }
    expect(repository.get("a", before.id, before.inputHash)).toEqual([1, 0]);
    expect(repository.search({ query: "oldword", mode: "lexical", limit: 5 }).results).toEqual([]);
    expect(
      repository.search({ query: "newword", mode: "lexical", limit: 5, bookId: "new-book" })
        .results[0],
    ).toMatchObject(after);
  });

  it("retains stale embeddings for reuse while excluding them from semantic results", () => {
    repository.ensureProfile("model", 2);
    const before = chunk("changed");
    repository.upsert("model", before, [1, 0]);
    const after = { ...before, inputHash: "new-input", text: "replacement" };
    repository.upsertChunks([after]);
    expect(repository.findCached("model", before.inputHash)).toEqual([1, 0]);
    expect(repository.search(vectorRequest()).results).toEqual([]);
    expect(
      repository.search({ query: "replacement", mode: "lexical", limit: 5 }).results[0],
    ).toMatchObject(after);
    // Returning to the same input activates the existing cached vector.
    repository.upsertChunks([before]);
    expect(repository.search(vectorRequest()).results[0]).toMatchObject(before);
  });

  it("retries upserts idempotently and replaces obsolete hashes in the cache", () => {
    repository.ensureProfile("model", 2);
    repository.upsert("model", chunk("chunk", { inputHash: "before" }), [1, 0]);
    const after = chunk("chunk", { inputHash: "after", text: "replacement" });
    repository.upsert("model", after, [0, 1]);
    repository.upsert("model", after, [0, 1]);
    expect(repository.count()).toBe(1);
    expect(repository.get("model", "chunk", "before")).toBeNull();
    expect(repository.findCached("model", "before")).toBeNull();
    expect(repository.findCached("model", "after")).toEqual([0, 1]);
    const response = repository.search(
      vectorRequest({ vector: [0, 1], mode: "hybrid", query: "replacement" }),
    );
    expect(response.results).toEqual([{ ...after, score: 2 / 61, matches: ["lexical", "vector"] }]);
  });

  it("rolls back payload, FTS and vector changes together if entry update fails", () => {
    repository.ensureProfile("model", 2);
    const before = chunk("chunk", { inputHash: "before", text: "originalword" });
    repository.upsert("model", before, [1, 0]);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER simulate_failure BEFORE UPDATE ON embedding_entries
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    raw.close();
    expect(() =>
      repository.upsert("model", { ...before, inputHash: "after", text: "replacement" }, [0, 1]),
    ).toThrow(/simulated/);
    expect(repository.get("model", "chunk", "before")).toEqual([1, 0]);
    const response = repository.search(vectorRequest({ mode: "hybrid", query: "originalword" }));
    expect(response.results).toEqual([
      { ...before, score: 2 / 61, matches: ["lexical", "vector"] },
    ]);
    expect(repository.search({ query: "replacement", mode: "lexical", limit: 5 }).results).toEqual(
      [],
    );
  });

  it("rolls back an entire payload batch on failure", () => {
    expect(() =>
      repository.upsertChunks([chunk("valid"), chunk("bad", { inputHash: "" })]),
    ).toThrow(/Input hash/);
    expect(repository.listChunkIds()).toEqual([]);
    expect(repository.search({ query: "valid", mode: "lexical", limit: 5 }).results).toEqual([]);
  });

  it("deletes payloads, FTS and every profile idempotently while retaining other cache entries", () => {
    repository.ensureProfile("a", 2);
    repository.ensureProfile("b", 3);
    const remove = chunk("remove", { inputHash: "shared", text: "removedword" });
    repository.upsert("a", remove, [1, 0]);
    repository.upsert("b", remove, [1, 0, 0]);
    repository.upsert("a", chunk("keep", { inputHash: "shared" }), [1, 0]);
    repository.upsertChunks([chunk("only-text", { text: "removedword" })]);
    repository.removeChunk("remove");
    repository.removeChunk("remove");
    repository.removeChunk("only-text");
    expect(repository.count()).toBe(1);
    expect(repository.listChunkIds()).toEqual(["keep"]);
    expect(repository.search(vectorRequest({ profileId: "b", vector: [1, 0, 0] })).results).toEqual(
      [],
    );
    expect(
      repository.search(vectorRequest({ profileId: "a" })).results.map((result) => result.id),
    ).toEqual(["keep"]);
    expect(repository.search({ query: "removedword", mode: "lexical", limit: 5 }).results).toEqual(
      [],
    );
    expect(repository.findCached("a", "shared")).toEqual([1, 0]);
  });

  it("rolls back deletion from all indexes if payload deletion fails", () => {
    repository.ensureProfile("model", 2);
    const original = chunk("rollback");
    repository.upsert("model", original, [1, 0]);
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER simulate_failure BEFORE DELETE ON search_chunks
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;`);
    raw.close();
    expect(() => repository.removeChunk(original.id)).toThrow(/simulated/);
    expect(repository.get("model", original.id, original.inputHash)).toEqual([1, 0]);
    expect(
      repository.search(vectorRequest({ mode: "hybrid", query: "rollback" })).results[0]?.matches,
    ).toEqual(["lexical", "vector"]);
  });

  it("fuses ranks and suppresses overlapping passages using indexed coordinates", () => {
    repository.ensureProfile("model", 2);
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
    repository.upsert("model", first, [1, 0]);
    repository.upsert("model", overlapping, [0.9, 0.1]);
    repository.upsert("model", separate, [0, 1]);
    const response = repository.search(vectorRequest({ query: "needle", mode: "hybrid" }));
    expect(response.results.map((result) => result.id)).toEqual(["a", "c"]);
    expect(response.results[0]?.matches).toEqual(["lexical", "vector"]);
    expect(response.results[0]?.score).toBe(2 / 61);
    expect(response.results[1]?.matches).toEqual(["vector"]);
  });

  it("falls back to lexical results for unavailable hybrid vectors", () => {
    repository.upsertChunks([chunk("lexical")]);
    const response = repository.search({ query: "Useful", mode: "hybrid", limit: 5 });
    expect(response.results[0]?.matches).toEqual(["lexical"]);
    expect(response.warnings[0]).toMatch(/Semantic search unavailable/);
    expect(() => repository.search({ query: "Useful", mode: "vector", limit: 5 })).toThrow(
      /profile/,
    );
  });

  it("rejects invalid dimensions and vectors without changing existing data", () => {
    repository.ensureProfile("model", 2);
    repository.ensureProfile("model", 2);
    expect(() => repository.ensureProfile("model", 3)).toThrow(/dimensions/);
    for (const dimensions of [0, 8193, 1.5]) {
      expect(() => repository.ensureProfile("bad", dimensions)).toThrow(/dimensions/);
    }
    repository.upsert("model", chunk("chunk", { inputHash: "good" }), [1, 0]);
    for (const vector of [[1], [NaN, 1], [Infinity, 1], [0, 0], [1e100, 0], [1e-100, 0]]) {
      expect(() =>
        repository.upsert("model", chunk("chunk", { inputHash: "bad" }), vector),
      ).toThrow();
      expect(() => repository.search(vectorRequest({ vector }))).toThrow();
    }
    expect(() => repository.upsert("missing", chunk("chunk"), [1, 0])).toThrow(/Unknown/);
    expect(() => repository.search(vectorRequest({ limit: 0 }))).toThrow(/limit/);
    expect(repository.get("model", "chunk", "good")).toEqual([1, 0]);
    expect(repository.count()).toBe(1);
  });

  it("drops unused v2 profile metadata without losing searchable payloads or vectors", () => {
    const original = chunk("preserved");
    repository.ensureProfile("model", 2);
    repository.upsert("model", original, [1, 0]);
    repository.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      ALTER TABLE embedding_profiles ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE embedding_profiles ADD COLUMN created_at TEXT NOT NULL DEFAULT 'old';
      PRAGMA user_version=2;
    `);
    raw.close();
    repository = new SqliteSearchRepository(path);
    expect(repository.get("model", original.id, original.inputHash)).toEqual([1, 0]);
    expect(
      repository.search(vectorRequest({ mode: "hybrid", query: "preserved" })).results[0],
    ).toMatchObject({ ...original, matches: ["lexical", "vector"] });
    repository.ensureProfile("new-model", 3);
    repository.upsert("new-model", original, [1, 0, 0]);
    expect(repository.count()).toBe(2);
  });

  it("refuses to open a database created by a newer schema", () => {
    repository.close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteSearchRepository(path)).toThrow(/newer/);
  });
});
