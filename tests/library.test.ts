import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BookLibrary, initializeLibrary } from "../src/library.js";
import { SqliteSearchRepository } from "../src/storage/search.js";
import type { AppConfig, EmbeddingProvider, IndexOptions, StoredChunk } from "../src/types.js";

let directory: string;
let config: AppConfig;
const openLibraries = new Set<BookLibrary>();

function fakeProvider(profileId = "profile-a", dimensions = 3) {
  return {
    profileId,
    config: {
      provider: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      model: profileId,
      dimensions,
      batchSize: 8,
      timeoutMs: 1000,
      retries: 0,
      documentPrefix: "",
      queryPrefix: "",
    },
    embed: vi
      .fn<EmbeddingProvider["embed"]>()
      .mockImplementation(async (texts) =>
        texts.map(() => Array.from({ length: dimensions }, (_, index) => index + 1)),
      ),
  } satisfies EmbeddingProvider;
}

function openLibrary(dependencies: ConstructorParameters<typeof BookLibrary>[1] = {}): BookLibrary {
  const library = new BookLibrary(config, dependencies);
  openLibraries.add(library);
  return library;
}

async function closeLibrary(library: BookLibrary): Promise<void> {
  library.close();
  openLibraries.delete(library);
}

async function bookFile(book: string, relativePath: string, markdown: string): Promise<string> {
  const path = join(config.booksDir, book, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown);
  return path;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memory-library-"));
  config = {
    booksDir: join(directory, "books"),
    dataDir: join(directory, "data"),
    chunking: { targetTokens: 800, overlapTokens: 100 },
  };
  await mkdir(config.booksDir);
});

afterEach(async () => {
  for (const library of openLibraries) library.close();
  openLibraries.clear();
  await rm(directory, { recursive: true, force: true });
});

describe("book library integration", () => {
  it.each([
    { booksDir: null },
    { dataDir: 123 },
    { chunking: undefined },
    { chunking: null },
    { chunking: [] },
    { chunking: { targetTokens: "800", overlapTokens: 100 } },
    { chunking: { targetTokens: 800, overlapTokens: 1.5 } },
    { embedding: null },
    { embedding: { provider: "ollama", model: ["private-config-input"] } },
  ])(
    "rejects malformed configuration before constructor or initializer IO %#",
    async (overrides) => {
      const input = {
        ...config,
        booksDir: join(directory, "uncreated", "books"),
        dataDir: join(directory, "uncreated", "data"),
        ...overrides,
      } as AppConfig;
      const before = await readdir(directory);
      const create = () => {
        // Injecting a provider must not bypass the configuration contract.
        const library = new BookLibrary(input, { provider: fakeProvider() });
        openLibraries.add(library);
      };
      expect(create).toThrow("Invalid library configuration structure");
      expect(create).not.toThrow("private-config-input");
      expect(await readdir(directory)).toEqual(before);

      const initialize = initializeLibrary(input);
      await expect(initialize).rejects.toThrow("Invalid library configuration structure");
      await expect(initialize).rejects.not.toThrow("private-config-input");
      await expect(initialize).rejects.not.toHaveProperty("issues");
      expect(await readdir(directory)).toEqual(before);
    },
  );

  it.each([null, [], {}, "private-config-input"])(
    "rejects invalid top-level configuration without creating storage %#",
    async (input) => {
      const create = () => {
        const library = new BookLibrary(input as AppConfig);
        openLibraries.add(library);
      };
      expect(create).toThrow("Invalid library configuration structure");
      await expect(initializeLibrary(input as AppConfig)).rejects.toThrow(
        "Invalid library configuration structure",
      );
      expect(await readdir(directory)).toEqual(["books"]);
    },
  );

  it("initializes a valid configuration and keeps the parsed configuration independent of its caller", async () => {
    const input = {
      ...config,
      booksDir: join(directory, "new-books"),
      chunking: { ...config.chunking },
      extraMetadata: "ignored",
    };
    await initializeLibrary(input);
    expect(await readdir(input.booksDir)).toEqual([]);
    expect(await readdir(input.dataDir)).toEqual(
      expect.arrayContaining(["content.sqlite", "vectors.sqlite"]),
    );
    const library = new BookLibrary(input);
    openLibraries.add(library);
    expect(library.config).not.toHaveProperty("extraMetadata");
    input.dataDir = join(directory, "different-data");
    input.chunking.targetTokens = 1;
    expect(library.config.dataDir).toBe(config.dataDir);
    expect(library.config.chunking.targetTokens).toBe(800);
  });

  it.each([null, [], "private-index-input", { embed: "false" }, { embed: 0 }, { embed: null }])(
    "rejects malformed indexing options before locking, writing or embedding %#",
    async (options) => {
      await bookFile("Book", "chapter.md", "# Chapter\nContent to index.");
      const provider = fakeProvider();
      const library = openLibrary({ provider });
      const before = library.content.status();
      const run = vi.spyOn(library.content, "withIndexingRun");
      const applySnapshot = vi.spyOn(library.content, "applySnapshot");
      const result = library.index(options as IndexOptions);
      await expect(result).rejects.toThrow("Invalid indexing options structure");
      await expect(result).rejects.not.toThrow("private-index-input");
      await expect(result).rejects.not.toHaveProperty("issues");
      expect(run).not.toHaveBeenCalled();
      expect(applySnapshot).not.toHaveBeenCalled();
      expect(library.content.status()).toEqual(before);
      expect(provider.embed).not.toHaveBeenCalled();
    },
  );

  it("keeps omitted, true and false embedding options and allows additional metadata", async () => {
    const provider = fakeProvider();
    const library = openLibrary({ provider });
    await bookFile("Book", "chapter.md", "# Chapter\nFirst content.");
    const options = { embed: false, metadata: "ignored" };
    expect(await library.index(options)).toMatchObject({ updated: 1, embedded: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(await library.index({ embed: true })).toMatchObject({ embedded: 1, failed: 0 });
    await bookFile("Book", "chapter.md", "# Chapter\nChanged content.");
    expect(await library.index()).toMatchObject({ updated: 1, embedded: 1, failed: 0 });
  });

  it.each([
    [undefined, {}, "Search query must be a string."],
    [42, {}, "Search query must be a string."],
    [{ value: "private-search-input" }, {}, "Search query must be a string."],
    ["query", null, "Search options must be an object."],
    ["query", [], "Search options must be an object."],
    ["query", "private-search-input", "Search options must be an object."],
    ["query", { mode: "" }, "Search mode must be lexical, vector or hybrid."],
    ["query", { mode: "private-search-input" }, "Search mode must be lexical, vector or hybrid."],
    ["query", { mode: null }, "Search mode must be lexical, vector or hybrid."],
    ["query", { limit: "10" }, "Search limit must be between 1 and 100."],
    ["query", { limit: 1.5 }, "Search limit must be between 1 and 100."],
    ["query", { limit: Number.NaN }, "Search limit must be between 1 and 100."],
    ["query", { limit: Number.POSITIVE_INFINITY }, "Search limit must be between 1 and 100."],
    ["query", { bookId: ["private-search-input"] }, "Search book ID must be a string."],
    ["query", { rerank: "false" }, "Search rerank must be a boolean."],
    [
      "query",
      { rerankStrategy: "private-search-input" },
      "Rerank strategy must be score or blend.",
    ],
  ] as const)(
    "rejects malformed search input before reading stores or embedding %#",
    async (query, options, message) => {
      const provider = fakeProvider();
      const store = new SqliteSearchRepository(":memory:");
      const library = openLibrary({ provider, search: store });
      const searchStore = vi.spyOn(store, "search");
      const chunks = vi.spyOn(library.content, "listChunks");
      // JavaScript callers can bypass the public TypeScript signature.
      const search = library.search.bind(library) as (
        query: unknown,
        options: unknown,
      ) => Promise<unknown>;
      const response = search(query, options);

      await expect(response).rejects.toThrow(message);
      await expect(response).rejects.not.toThrow("private-search-input");
      expect(searchStore).not.toHaveBeenCalled();
      expect(chunks).not.toHaveBeenCalled();
      expect(provider.embed).not.toHaveBeenCalled();
    },
  );

  it.each([
    [" \t\n", undefined, "Search query must not be empty."],
    ["a".repeat(8193), undefined, "Search query is too long"],
    ["query", 0, "Search limit must be between 1 and 100."],
    ["query", 101, "Search limit must be between 1 and 100."],
  ] as const)(
    "retains query and result-limit policies after structural validation %#",
    async (query, limit, message) => {
      const library = openLibrary();
      await expect(library.search(query, { mode: "lexical", limit })).rejects.toThrow(message);
    },
  );

  it("keeps search defaults and ignores unknown options from JavaScript clients", async () => {
    const store = new SqliteSearchRepository(":memory:");
    const library = openLibrary({ search: store });
    const searchStore = vi.spyOn(store, "search");
    expect(await library.search("query")).toMatchObject({ mode: "hybrid", results: [] });
    expect(searchStore).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "query", mode: "lexical", limit: 10 }),
    );

    const options = { mode: "lexical" as const, limit: 100, ignored: "extra metadata" };
    expect(await library.search("query", options)).toEqual({
      mode: "lexical",
      warnings: [],
      results: [],
    });
    expect(searchStore).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "query", mode: "lexical", limit: 100 }),
    );
  });

  it("indexes nested book files into both databases and returns exact citations", async () => {
    const source = "# Морські подорожі\n\nМореплавство потребує знання вітрів.\n";
    await bookFile("Подорожі", "частина-1/02-море.md", source);
    await bookFile("Подорожі", "01-вступ.md", "# Вступ\n\nПланування подорожей.\n");
    await bookFile("Рослини", "book.md", "# Сад\n\nДерева ростуть біля річки.\n");
    const provider = fakeProvider();
    const library = openLibrary({ provider });

    const report = await library.index();
    expect(report).toMatchObject({ books: 2, updated: 3, unchanged: 0, removed: 0, failed: 0 });
    const status = library.status();
    expect(status).toMatchObject({ books: 2, documents: 3, vectors: { pendingEmbeddings: 0 } });
    expect(status.chunks).toBeGreaterThanOrEqual(3);
    expect(status.vectors.count).toBe(status.chunks);
    expect(report.embedded).toBe(status.chunks);
    expect((await readFile(join(config.dataDir, "content.sqlite"))).length).toBeGreaterThan(0);
    expect((await readFile(join(config.dataDir, "vectors.sqlite"))).length).toBeGreaterThan(0);

    const response = await library.search("Мореплавство", { mode: "hybrid" });
    const match = response.results.find((result) => result.text.includes("Мореплавство"))!;
    expect(response.warnings).toEqual([]);
    expect(match).toMatchObject({
      bookTitle: "Подорожі",
      relativePath: "частина-1/02-море.md",
      matches: ["lexical", "vector"],
    });
    expect(match.markdown).toBe(source.slice(match.startOffset, match.endOffset));
    expect(match.headingPath).toContain("Морські подорожі");
    expect(match.anchor).toBeTruthy();
    expect(match.startLine).toBeGreaterThan(0);
    const document = library.content.getDocument(match.documentId);
    expect(document?.markdown).toBe(source);
  });

  it("does not request embeddings or replace chunks when sources are unchanged", async () => {
    await bookFile("Книга", "book.md", "# Розділ\n\nНезмінний текст книги.\n");
    const provider = fakeProvider();
    const library = openLibrary({ provider });
    await library.index();
    const chunks = library.content.listChunks();
    provider.embed.mockClear();

    expect(await library.index()).toMatchObject({
      updated: 0,
      unchanged: 1,
      embedded: 0,
      reused: 0,
      failed: 0,
    });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(library.content.listChunks()).toEqual(chunks);
  });

  it("deduplicates identical inputs across the whole run before batching", async () => {
    for (let i = 0; i < 5; i++) await bookFile("Book", `${i}.md`, "# Shared\n\nIdentical input.\n");
    const provider = fakeProvider();
    provider.config.batchSize = 2;
    const library = openLibrary({ provider });
    expect(await library.index()).toMatchObject({ embedded: 5, reused: 0, failed: 0 });
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed.mock.calls[0]![0]).toHaveLength(1);
    expect(library.status().vectors).toMatchObject({ count: 5, pendingEmbeddings: 0 });
  });

  it("preserves cached renamed inputs even when generating another input fails", async () => {
    const source = await bookFile("Book", "old.md", "# Saved\n\nReusable content.\n");
    const provider = fakeProvider();
    provider.config.batchSize = 1;
    const library = openLibrary({ provider });
    await library.index();
    await rename(source, join(dirname(source), "z-renamed.md"));
    await bookFile("Book", "a-new.md", "# New\n\nNeeds inference.\n");
    provider.embed.mockRejectedValueOnce(new Error("offline"));
    expect(await library.index()).toMatchObject({ reused: 1, failed: 1 });
    expect(library.status().vectors).toMatchObject({ count: 1, pendingEmbeddings: 1 });
    const results = await library.search("Saved", { mode: "vector" });
    expect(results.results[0]?.relativePath).toBe("z-renamed.md");
  });

  it("keeps lexical search current and excludes old vectors while updated text awaits embeddings", async () => {
    const path = await bookFile("Книга", "book.md", "# Розділ\n\nСтародрук описує давнє місто.\n");
    const provider = fakeProvider();
    const library = openLibrary({ provider });
    await library.index();
    const oldIds = library.content.listChunks().map(({ id }) => id);
    provider.embed.mockClear();
    await writeFile(path, "# Розділ\n\nНовобудова прикрашає сучасне місто.\n");

    expect(await library.index({ embed: false })).toMatchObject({ updated: 1, embedded: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect((await library.search("Стародрук", { mode: "lexical" })).results).toEqual([]);
    expect((await library.search("Новобудова", { mode: "lexical" })).results).toHaveLength(1);
    const incomplete = await library.search("Новобудова", { mode: "vector" });
    expect(incomplete.results).toEqual([]);
    expect(incomplete.warnings.join(" ")).toMatch(/incomplete|No current embeddings/);
    expect(library.status().vectors.pendingEmbeddings).toBe(library.content.listChunks().length);

    const resumed = await library.embed();
    expect(resumed.failed).toBe(0);
    expect(resumed.embedded).toBe(library.content.listChunks().length);
    const results = (await library.search("Новобудова", { mode: "vector" })).results;
    expect(results).toHaveLength(1);
    expect(results.every(({ id }) => !oldIds.includes(id))).toBe(true);
    expect(library.status().vectors.pendingEmbeddings).toBe(0);
  });

  it("removes deleted files and books from text and vectors", async () => {
    const removedFile = await bookFile("Книга", "01.md", "# Перший\n\nФрагмент першого розділу.\n");
    await bookFile("Книга", "02.md", "# Другий\n\nФрагмент другого розділу.\n");
    const library = openLibrary({ provider: fakeProvider() });
    await library.index();
    await rm(removedFile);

    expect(await library.index()).toMatchObject({ removed: 1, unchanged: 1 });
    expect(library.status()).toMatchObject({
      books: 1,
      documents: 1,
      vectors: { pendingEmbeddings: 0 },
    });
    expect(library.status().vectors.count).toBe(library.status().chunks);
    expect((await library.search("Перший", { mode: "lexical" })).results).toEqual([]);
    await rm(join(config.booksDir, "Книга"), { recursive: true });
    expect(await library.index()).toMatchObject({ removed: 1, books: 0 });
    expect(library.status()).toMatchObject({
      books: 0,
      documents: 0,
      chunks: 0,
      vectors: { pendingEmbeddings: 0, count: 0 },
    });
  });

  it("invalidates embedding context and lexical title when book metadata changes", async () => {
    await bookFile("directory", "book.md", "# Розділ\n\nНезмінний текст.\n");
    const manifest = await bookFile(
      "directory",
      "book.json",
      JSON.stringify({ title: "СтараНазва" }),
    );
    const provider = fakeProvider();
    const library = openLibrary({ provider });
    await library.index();
    const original = library.content.listChunks()[0]!;
    provider.embed.mockClear();
    await writeFile(manifest, JSON.stringify({ title: "НоваНазва", author: "Автор" }));

    expect(await library.index({ embed: false })).toMatchObject({ updated: 1, embedded: 0 });
    const updated = library.content.listChunks()[0]!;
    expect(updated.contentHash).toBe(original.contentHash);
    expect(updated.inputHash).not.toBe(original.inputHash);
    expect(updated.bookTitle).toBe("НоваНазва");
    expect((await library.search("СтараНазва", { mode: "lexical" })).results).toEqual([]);
    expect((await library.search("НоваНазва", { mode: "lexical" })).results).toHaveLength(1);
    expect(provider.embed).not.toHaveBeenCalled();
    expect((await library.search("текст", { mode: "vector" })).results).toEqual([]);
    expect(provider.embed).toHaveBeenCalledExactlyOnceWith(["текст"], "query");
    provider.embed.mockClear();

    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(provider.embed.mock.calls[0]?.[0][0]).toContain("НоваНазва");
    expect(library.status().vectors.pendingEmbeddings).toBe(0);
  });

  it("rebuilds a deleted vector database from persisted text without re-reading source files", async () => {
    await bookFile("Книга", "book.md", "# Пам'ять\n\nЗбережений оригінал книги.\n");
    const provider = fakeProvider();
    const initial = openLibrary({ provider });
    await initial.index();
    const chunks = initial.content.listChunks();
    await closeLibrary(initial);
    await rm(join(config.dataDir, "vectors.sqlite"));
    // embed operates on the content database, even if source media is temporarily unavailable.
    await rm(config.booksDir, { recursive: true });
    provider.embed.mockClear();
    const restored = openLibrary({ provider });

    const report = await restored.embed();
    expect(report).toMatchObject({ embedded: chunks.length, failed: 0 });
    expect(provider.embed).toHaveBeenCalled();
    expect(restored.content.listChunks()).toEqual(chunks);
    expect(restored.status()).toMatchObject({
      vectors: { pendingEmbeddings: 0, count: chunks.length },
    });
    expect((await restored.search("оригінал", { mode: "vector" })).results).not.toHaveLength(0);
  });

  it("persists provider failures, keeps text searchable, and resumes after reopening", async () => {
    await bookFile("Книга", "book.md", "# Природа\n\nСоняшник росте на полі.\n");
    const provider = fakeProvider();
    provider.embed.mockRejectedValueOnce(new Error("Simulated provider unavailable"));
    const initial = openLibrary({ provider });

    const report = await initial.index();
    expect(report.failed).toBeGreaterThan(0);
    expect(report.warnings).toContain("Simulated provider unavailable");
    expect(initial.status()).toMatchObject({
      vectors: { pendingEmbeddings: 1 },
      lastRun: { status: "partial" },
    });
    expect(JSON.parse(initial.status().lastRun!.details as string).warnings).toContain(
      "Simulated provider unavailable",
    );
    expect((await initial.search("Соняшник", { mode: "lexical" })).results).toHaveLength(1);
    await closeLibrary(initial);

    const resumed = openLibrary({ provider });
    expect(await resumed.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(resumed.status()).toMatchObject({
      vectors: { pendingEmbeddings: 0 },
      lastRun: { status: "completed" },
    });
    expect((await resumed.search("Соняшник", { mode: "hybrid" })).results[0]?.matches).toEqual([
      "lexical",
      "vector",
    ]);
  });

  it("separates model profiles and never searches previous-model embeddings", async () => {
    await bookFile("Книга", "book.md", "# Розділ\n\nПошук за змістом книги.\n");
    const oldProvider = fakeProvider("old-model", 2);
    const initial = openLibrary({ provider: oldProvider });
    await initial.index();
    await closeLibrary(initial);
    const newProvider = fakeProvider("new-model", 3);
    const library = openLibrary({ provider: newProvider });

    const empty = await library.search("змістом", { mode: "vector" });
    expect(empty.results).toEqual([]);
    expect(newProvider.embed).toHaveBeenCalledExactlyOnceWith(["змістом"], "query");
    expect(empty.warnings.join(" ")).toContain("profile");
    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(library.status().vectors.profiles).toEqual([
      { id: "new-model", dimensions: 3 },
      { id: "old-model", dimensions: 2 },
    ]);
    expect((await library.search("змістом", { mode: "vector" })).results).toHaveLength(1);
    await closeLibrary(library);
    oldProvider.embed.mockClear();
    const originalAgain = openLibrary({ provider: oldProvider });
    expect(await originalAgain.embed()).toMatchObject({ embedded: 0, failed: 0 });
    expect(oldProvider.embed).not.toHaveBeenCalled();
  });

  it("filters the selected book before vector ranking so other books cannot crowd it out", async () => {
    for (let index = 0; index < 40; index++) {
      await bookFile(
        "Distractors",
        `${index}.md`,
        `# Сусідній розділ ${index}\n\nСпільний пошук для іншої книги ${index}.\n`,
      );
    }
    await bookFile("Target", "book.md", "# Шукана книга\n\nСпільний пошук у вибраній книзі.\n");
    const provider = fakeProvider("filtered-model", 2);
    provider.embed.mockImplementation(async (texts, kind) =>
      texts.map((text) => (kind === "query" || !text.includes("Шукана") ? [1, 0] : [0, 1])),
    );
    const library = openLibrary({ provider });
    await library.index();
    const target = library.content.listChunks().find(({ bookTitle }) => bookTitle === "Target")!;

    const unfiltered = await library.search("Спільний", { mode: "vector", limit: 1 });
    expect(unfiltered.results[0]?.bookTitle).toBe("Distractors");
    for (const mode of ["lexical", "vector", "hybrid"] as const) {
      const filtered = await library.search("Спільний", { mode, limit: 1, bookId: target.bookId });
      expect(filtered.results).toHaveLength(1);
      expect(filtered.results[0]?.bookId).toBe(target.bookId);
    }
  });

  it("leaves the previous snapshot intact when a malformed book manifest aborts discovery", async () => {
    const firstPath = await bookFile("First", "book.md", "# Перший\n\nЗбережений матеріал.\n");
    await bookFile("Second", "book.md", "# Другий\n\nДругий матеріал.\n");
    const library = openLibrary({ provider: fakeProvider() });
    await library.index();
    const prior = library.content.listChunks();
    await rm(firstPath);
    const manifest = await bookFile("Second", "book.json", "{broken");

    await expect(library.index()).rejects.toThrow("invalid JSON");
    expect(library.content.listChunks()).toEqual(prior);
    expect(library.status()).toMatchObject({
      documents: 2,
      vectors: { count: prior.length },
      lastRun: { status: "failed" },
    });
    expect((await library.search("Збережений", { mode: "lexical" })).results).toHaveLength(1);
    // Correcting the source also verifies that a failed run released the writer lock.
    await writeFile(manifest, "{}");
    expect(await library.index()).toMatchObject({ removed: 1, failed: 0 });
  });

  it("does not regenerate a committed vector after an interrupted write", async () => {
    await bookFile("Книга", "book.md", "# Відновлення\n\nСтійкий до переривань індекс.\n");
    class InterruptedVectorRepository extends SqliteSearchRepository {
      override upsert(profileId: string, chunk: StoredChunk, vector: number[]): void {
        super.upsert(profileId, chunk, vector);
        throw new Error("Simulated interruption after durable vector write");
      }
    }
    const provider = fakeProvider();
    const vectors = new InterruptedVectorRepository(join(config.dataDir, "vectors.sqlite"));
    const interrupted = openLibrary({ provider, search: vectors });

    expect(await interrupted.index()).toMatchObject({ failed: 1 });
    expect(interrupted.status()).toMatchObject({
      vectors: { count: 1, pendingEmbeddings: 0 },
    });
    await closeLibrary(interrupted);
    provider.embed.mockClear();
    const recovered = openLibrary({ provider });
    expect(await recovered.embed()).toMatchObject({ reused: 0, embedded: 0, failed: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(recovered.status()).toMatchObject({ vectors: { count: 1, pendingEmbeddings: 0 } });
    expect((await recovered.search("індекс", { mode: "vector" })).results).toHaveLength(1);
  });

  it("rejects a concurrent writer while preserving readers and releases the lock on completion", async () => {
    await bookFile("Книга", "book.md", "# Паралельність\n\nЧитання доступне під час індексації.\n");
    const provider = fakeProvider();
    let started!: () => void;
    let resume!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    provider.embed.mockImplementationOnce(async (texts) => {
      started();
      await paused;
      return texts.map(() => [1, 2, 3]);
    });
    const first = openLibrary({ provider });
    const second = openLibrary({ provider: fakeProvider() });
    const indexing = first.index();
    await requested;
    try {
      await expect(second.index()).rejects.toThrow("database lock");
      await expect(second.embed()).rejects.toThrow("database lock");
      expect((await second.search("Читання", { mode: "lexical" })).results).toHaveLength(1);
    } finally {
      resume();
      await indexing;
    }
    expect(await second.index()).toMatchObject({ unchanged: 1, failed: 0 });
  });

  it.each(["formatting", "rename"] as const)(
    "reuses unchanged embedding inputs after a %s edit indexed without provider requests",
    async (change) => {
      const source = "# Розділ\n\nНезмінний зміст книги.\n";
      const path = await bookFile("Книга", "original.md", source);
      const provider = fakeProvider();
      const library = openLibrary({ provider });
      await library.index();
      const original = library.content.listChunks()[0]!;
      provider.embed.mockClear();

      if (change === "formatting") {
        await writeFile(path, "# Розділ\n\n**Незмінний** зміст книги.\n");
      } else {
        await rename(path, join(dirname(path), "renamed.md"));
      }

      expect(await library.index({ embed: false })).toMatchObject({ embedded: 0, failed: 0 });
      const updated = library.content.listChunks()[0]!;
      expect(updated.id).not.toBe(original.id);
      expect(updated.inputHash).toBe(original.inputHash);
      expect(provider.embed).not.toHaveBeenCalled();

      expect(await library.embed()).toMatchObject({ embedded: 0, failed: 0 });
      expect(provider.embed).not.toHaveBeenCalled();
      expect(library.status()).toMatchObject({ vectors: { count: 1, pendingEmbeddings: 0 } });
      const results = (await library.search("зміст", { mode: "vector" })).results;
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(updated.id);
      expect(results[0]?.markdown).toBe(updated.markdown);
    },
  );

  it("does not delete existing content or vectors when the books directory is unavailable", async () => {
    await bookFile("Книга", "book.md", "# Архів\n\nМатеріал на тимчасово недоступному диску.\n");
    const library = openLibrary({ provider: fakeProvider() });
    await library.index();
    const prior = library.content.listChunks();
    await rename(config.booksDir, join(directory, "temporarily-unmounted-books"));

    await expect(library.index()).rejects.toThrow();
    expect(library.content.listChunks()).toEqual(prior);
    expect(library.status()).toMatchObject({
      documents: 1,
      vectors: { count: prior.length },
      lastRun: { status: "failed" },
    });
    expect((await library.search("Матеріал", { mode: "lexical" })).results).toHaveLength(1);

    await rename(join(directory, "temporarily-unmounted-books"), config.booksDir);
    expect(await library.index()).toMatchObject({ unchanged: 1, removed: 0, failed: 0 });
  });

  it("replays an interrupted vector deletion after the content removal was committed", async () => {
    const source = await bookFile(
      "Книга",
      "book.md",
      "# Видалення\n\nТекст, який буде видалено.\n",
    );
    class InterruptedDeletionRepository extends SqliteSearchRepository {
      override removeChunk(chunkId: string): void {
        super.removeChunk(chunkId);
        throw new Error("Simulated interruption after durable vector deletion");
      }
    }
    const provider = fakeProvider();
    const vectors = new InterruptedDeletionRepository(join(config.dataDir, "vectors.sqlite"));
    const initial = openLibrary({ provider, search: vectors });
    await initial.index();
    await rm(source);

    await expect(initial.index()).rejects.toThrow(
      "Simulated interruption after durable vector deletion",
    );
    expect(initial.status()).toMatchObject({
      chunks: 0,
      vectors: { count: 0, pendingEmbeddings: 0 },
      lastRun: { status: "failed" },
    });
    expect((await initial.search("Текст", { mode: "lexical" })).results).toEqual([]);
    await closeLibrary(initial);
    provider.embed.mockClear();

    const recovered = openLibrary({ provider });
    expect(await recovered.embed()).toMatchObject({ embedded: 0, failed: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(recovered.status()).toMatchObject({
      chunks: 0,
      vectors: { count: 0, pendingEmbeddings: 0 },
    });
  });

  it("does not count completed vector writes as failed when a later write in the batch fails", async () => {
    await bookFile("Книга", "01.md", "# Перший\n\nПерший незалежний фрагмент.\n");
    await bookFile("Книга", "02.md", "# Другий\n\nДругий незалежний фрагмент.\n");
    class PartialWriteRepository extends SqliteSearchRepository {
      writes = 0;

      override upsert(profileId: string, chunk: StoredChunk, vector: number[]): void {
        if (++this.writes === 2) throw new Error("Simulated second vector write failure");
        super.upsert(profileId, chunk, vector);
      }
    }
    const provider = fakeProvider();
    const vectors = new PartialWriteRepository(join(config.dataDir, "vectors.sqlite"));
    const library = openLibrary({ provider, search: vectors });

    const failed = await library.index();
    expect(failed).toMatchObject({ embedded: 1, failed: 1 });
    expect(library.status()).toMatchObject({
      chunks: 2,
      vectors: { count: 1, pendingEmbeddings: 1 },
    });
    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(library.status()).toMatchObject({
      vectors: { count: 2, pendingEmbeddings: 0 },
    });
  });

  it.each(["lexical", "vector", "hybrid"] as const)(
    "serves %s search and book filters without reading the content database",
    async (mode) => {
      await bookFile("Target", "nested/chapter.md", "# Navigation\n\nSailing across the ocean.\n");
      await bookFile("Other", "chapter.md", "# Navigation\n\nSailing across the lake.\n");
      const library = openLibrary({ provider: fakeProvider() });
      await library.index();
      const expected = library.content
        .listChunks()
        .find(({ bookTitle }) => bookTitle === "Target")!;
      const reads = [
        "getChunk",
        "listChunks",
        "getDocument",
        "getDocumentState",
        "listBooks",
        "listSections",
        "status",
        "withIndexingRun",
      ] as const;
      const spies = reads.map((method) =>
        vi.spyOn(library.content, method).mockImplementation(() => {
          throw new Error(`Search must not call Content DB ${method}`);
        }),
      );

      const response = await library.search("Sailing", { mode, bookId: expected.bookId });
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toMatchObject(expected);
      expect(response.results[0]?.matches).toEqual(
        mode === "hybrid" ? ["lexical", "vector"] : [mode],
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refreshes citation coordinates for unchanged chunk IDs without regenerating embeddings", async () => {
    const source = "# Navigation\n\nSailing across the ocean.\n";
    const path = await bookFile("Book", "chapter.md", source);
    const provider = fakeProvider();
    const library = openLibrary({ provider });
    await library.index();
    const previous = library.content.listChunks()[0]!;
    provider.embed.mockClear();
    await writeFile(path, `\n\n${source}`);

    expect(await library.index({ embed: false })).toMatchObject({
      updated: 1,
      embedded: 0,
      failed: 0,
    });
    const current = library.content.listChunks()[0]!;
    expect(current.id).toBe(previous.id);
    expect(current.inputHash).toBe(previous.inputHash);
    expect(current.startOffset).toBe(previous.startOffset + 2);
    expect(current.startLine).toBe(previous.startLine + 2);
    expect(provider.embed).not.toHaveBeenCalled();
    for (const mode of ["lexical", "vector", "hybrid"] as const) {
      const response = await library.search("Sailing", { mode });
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toMatchObject(current);
    }
    expect(provider.embed.mock.calls.every(([, kind]) => kind === "query")).toBe(true);
  });

  it("updates and removes lexical search records without an embedding provider", async () => {
    const source = await bookFile("Book", "chapter.md", "# Chapter\n\nOriginal material.\n");
    const library = openLibrary();
    expect(await library.index()).toMatchObject({ updated: 1, embedded: 0, failed: 0 });
    expect((await library.search("Original", { mode: "lexical" })).results).toHaveLength(1);
    await writeFile(source, "# Chapter\n\nReplacement material.\n");

    expect(await library.index()).toMatchObject({ updated: 1, embedded: 0, failed: 0 });
    expect((await library.search("Original", { mode: "lexical" })).results).toEqual([]);
    expect((await library.search("Replacement", { mode: "lexical" })).results).toHaveLength(1);
    expect(library.status().vectors.pendingEmbeddings).toBeNull();
    await rm(source);
    expect(await library.index()).toMatchObject({ removed: 1, failed: 0 });
    expect((await library.search("Replacement", { mode: "lexical" })).results).toEqual([]);
    expect(library.status()).toMatchObject({ chunks: 0, vectors: { pendingEmbeddings: null } });
  });

  it("retries failed payload delivery after reopening without a provider", async () => {
    await bookFile("Book", "chapter.md", "# Recovery\n\nDurable searchable text.\n");
    class InterruptedPayloadRepository extends SqliteSearchRepository {
      override upsertChunks(chunks: StoredChunk[]): void {
        super.upsertChunks(chunks);
        throw new Error("Simulated interruption after durable search payload write");
      }
    }
    const search = new InterruptedPayloadRepository(join(config.dataDir, "vectors.sqlite"));
    const initial = openLibrary({ search });
    const report = await initial.index();
    expect(report.failed).toBeGreaterThan(0);
    expect(initial.content.listChunks()).toHaveLength(1);
    await closeLibrary(initial);

    const recovered = openLibrary();
    expect(await recovered.index()).toMatchObject({ unchanged: 1, failed: 0 });

    expect((await recovered.search("Durable", { mode: "lexical" })).results).toHaveLength(1);
  });

  it("reopens a complete search index without opening or recreating the content database", async () => {
    const provider = fakeProvider();
    await bookFile("Book", "nested/chapter.md", "# Navigation\n\nSailing across the ocean.\n");
    const initial = openLibrary({ provider });
    await initial.index();
    const expected = initial.content.listChunks()[0]!;
    await closeLibrary(initial);
    await rm(config.booksDir, { recursive: true });
    const contentPath = join(config.dataDir, "content.sqlite");
    await rename(contentPath, `${contentPath}.saved`);
    const reopened = openLibrary({ provider });

    for (const mode of ["lexical", "vector", "hybrid"] as const) {
      const response = await reopened.search("Sailing", { mode, bookId: expected.bookId });
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toMatchObject(expected);
    }
    await closeLibrary(reopened);
    await expect(readFile(contentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("searches the current search snapshot after the query embedding completes", async () => {
    const source = await bookFile("Книга", "book.md", "# Розділ\n\nЗастарілий матеріал.\n");
    const provider = fakeProvider();
    const reader = openLibrary({ provider });
    const writer = openLibrary({ provider: fakeProvider() });
    await reader.index();
    let queryStarted!: () => void;
    let resumeQuery!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resumeQuery = resolve;
    });
    provider.embed.mockImplementationOnce(async (texts, kind) => {
      expect(kind).toBe("query");
      queryStarted();
      await paused;
      return texts.map(() => [1, 2, 3]);
    });
    const searching = reader.search("матеріал", { mode: "hybrid" });
    await started;
    try {
      await writeFile(source, "# Розділ\n\nОновлений матеріал.\n");
      await writer.index({ embed: false });
    } finally {
      resumeQuery();
    }

    const response = await searching;
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      text: expect.stringContaining("Оновлений матеріал."),
      matches: ["lexical"],
    });
    expect((await reader.search("Оновлений", { mode: "lexical" })).results).toHaveLength(1);
  });
});
