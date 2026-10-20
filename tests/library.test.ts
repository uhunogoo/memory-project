import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BookLibrary } from "../src/library.js";
import { SqliteVectorRepository } from "../src/storage/vectors.js";
import type { AppConfig, EmbeddingProvider } from "../src/types.js";

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

function closeLibrary(library: BookLibrary): void {
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
  ] as const)(
    "rejects malformed search input before reading stores or embedding %#",
    async (query, options, message) => {
      const provider = fakeProvider();
      const library = openLibrary({ provider });
      const lexical = vi.spyOn(library.content, "searchLexical");
      const chunks = vi.spyOn(library.content, "listChunks");
      // JavaScript callers can bypass the public TypeScript signature.
      const search = library.search.bind(library) as (
        query: unknown,
        options: unknown,
      ) => Promise<unknown>;
      const response = search(query, options);

      await expect(response).rejects.toThrow(message);
      await expect(response).rejects.not.toThrow("private-search-input");
      expect(lexical).not.toHaveBeenCalled();
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
    const library = openLibrary();
    const lexical = vi.spyOn(library.content, "searchLexical");
    expect(await library.search("query")).toMatchObject({ mode: "hybrid", results: [] });
    expect(lexical).toHaveBeenLastCalledWith("query", 30, undefined);

    const options = { mode: "lexical" as const, limit: 100, ignored: "extra metadata" };
    expect(await library.search("query", options)).toEqual({
      mode: "lexical",
      warnings: [],
      results: [],
    });
    expect(lexical).toHaveBeenLastCalledWith("query", 300, undefined);
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
    expect(status).toMatchObject({ books: 2, documents: 3, pendingVectorJobs: 0 });
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
    expect(library.content.jobs()).toHaveLength(library.content.listChunks().length);

    const resumed = await library.embed();
    expect(resumed.failed).toBe(0);
    expect(resumed.embedded).toBe(library.content.listChunks().length);
    const results = (await library.search("Новобудова", { mode: "vector" })).results;
    expect(results).toHaveLength(1);
    expect(results.every(({ id }) => !oldIds.includes(id))).toBe(true);
    expect(library.status().pendingVectorJobs).toBe(0);
  });

  it("removes deleted files and books from text, vectors, and pending jobs", async () => {
    const removedFile = await bookFile("Книга", "01.md", "# Перший\n\nФрагмент першого розділу.\n");
    await bookFile("Книга", "02.md", "# Другий\n\nФрагмент другого розділу.\n");
    const library = openLibrary({ provider: fakeProvider() });
    await library.index();
    await rm(removedFile);

    expect(await library.index()).toMatchObject({ removed: 1, unchanged: 1 });
    expect(library.status()).toMatchObject({ books: 1, documents: 1, pendingVectorJobs: 0 });
    expect(library.status().vectors.count).toBe(library.status().chunks);
    expect((await library.search("Перший", { mode: "lexical" })).results).toEqual([]);
    await rm(join(config.booksDir, "Книга"), { recursive: true });
    expect(await library.index()).toMatchObject({ removed: 1, books: 0 });
    expect(library.status()).toMatchObject({
      books: 0,
      documents: 0,
      chunks: 0,
      pendingVectorJobs: 0,
      vectors: { count: 0 },
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
    expect((await library.search("текст", { mode: "vector" })).results).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();

    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(provider.embed.mock.calls[0]?.[0][0]).toContain("НоваНазва");
    expect(library.status().pendingVectorJobs).toBe(0);
  });

  it("rebuilds a deleted vector database from persisted text without re-reading source files", async () => {
    await bookFile("Книга", "book.md", "# Пам'ять\n\nЗбережений оригінал книги.\n");
    const provider = fakeProvider();
    const initial = openLibrary({ provider });
    await initial.index();
    const chunks = initial.content.listChunks();
    closeLibrary(initial);
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
      pendingVectorJobs: 0,
      vectors: { count: chunks.length },
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
      failedVectorJobs: 1,
      pendingVectorJobs: 1,
      lastRun: { status: "partial" },
    });
    expect(initial.content.jobs()[0]).toMatchObject({
      attempts: 1,
      lastError: "Simulated provider unavailable",
    });
    expect((await initial.search("Соняшник", { mode: "lexical" })).results).toHaveLength(1);
    closeLibrary(initial);

    const resumed = openLibrary({ provider });
    expect(await resumed.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(resumed.status()).toMatchObject({
      failedVectorJobs: 0,
      pendingVectorJobs: 0,
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
    closeLibrary(initial);
    const newProvider = fakeProvider("new-model", 3);
    const library = openLibrary({ provider: newProvider });

    const empty = await library.search("змістом", { mode: "vector" });
    expect(empty.results).toEqual([]);
    expect(newProvider.embed).not.toHaveBeenCalled();
    expect(empty.warnings.join(" ")).toContain("profile");
    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(library.status().vectors.profiles).toEqual([
      { id: "new-model", dimensions: 3 },
      { id: "old-model", dimensions: 2 },
    ]);
    expect((await library.search("змістом", { mode: "vector" })).results).toHaveLength(1);
    closeLibrary(library);
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

  it("replays the outbox after a vector commit succeeds but its acknowledgement is interrupted", async () => {
    await bookFile("Книга", "book.md", "# Відновлення\n\nСтійкий до переривань індекс.\n");
    class InterruptedVectorRepository extends SqliteVectorRepository {
      override upsert(
        profileId: string,
        chunkId: string,
        inputHash: string,
        vector: number[],
      ): void {
        super.upsert(profileId, chunkId, inputHash, vector);
        throw new Error("Simulated interruption after durable vector write");
      }
    }
    const provider = fakeProvider();
    const vectors = new InterruptedVectorRepository(join(config.dataDir, "vectors.sqlite"));
    const interrupted = openLibrary({ provider, vectors });

    expect(await interrupted.index()).toMatchObject({ failed: 1 });
    expect(interrupted.status()).toMatchObject({ vectors: { count: 1 }, pendingVectorJobs: 1 });
    closeLibrary(interrupted);
    provider.embed.mockClear();
    const recovered = openLibrary({ provider });
    expect(await recovered.embed()).toMatchObject({ reused: 1, embedded: 0, failed: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(recovered.status()).toMatchObject({ vectors: { count: 1 }, pendingVectorJobs: 0 });
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

  it.each(["index", "embed"] as const)(
    "releases its writer lock when %s cannot create an indexing run",
    async (operation) => {
      await bookFile("Книга", "book.md", "# Розділ\n\nЗбереження стану індексації.\n");
      const library = openLibrary({ provider: fakeProvider() });
      const startRun = vi.spyOn(library.content, "startRun").mockImplementationOnce(() => {
        throw new Error("Simulated run creation failure");
      });

      await expect(library[operation]()).rejects.toThrow("Simulated run creation failure");
      startRun.mockRestore();

      expect(await library.index()).toMatchObject({ updated: 1, failed: 0 });
      expect(library.status()).toMatchObject({
        pendingVectorJobs: 0,
        lastRun: { status: "completed" },
      });
    },
  );

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
      expect(library.status()).toMatchObject({ pendingVectorJobs: 0, vectors: { count: 1 } });
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
    class InterruptedDeletionRepository extends SqliteVectorRepository {
      override removeChunk(chunkId: string): void {
        super.removeChunk(chunkId);
        throw new Error("Simulated interruption after durable vector deletion");
      }
    }
    const provider = fakeProvider();
    const vectors = new InterruptedDeletionRepository(join(config.dataDir, "vectors.sqlite"));
    const initial = openLibrary({ provider, vectors });
    await initial.index();
    await rm(source);

    await expect(initial.index()).rejects.toThrow(
      "Simulated interruption after durable vector deletion",
    );
    expect(initial.status()).toMatchObject({
      chunks: 0,
      vectors: { count: 0 },
      pendingVectorJobs: 1,
      lastRun: { status: "failed" },
    });
    expect((await initial.search("Текст", { mode: "lexical" })).results).toEqual([]);
    closeLibrary(initial);
    provider.embed.mockClear();

    const recovered = openLibrary({ provider });
    expect(await recovered.embed()).toMatchObject({ embedded: 0, failed: 0 });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(recovered.status()).toMatchObject({
      chunks: 0,
      vectors: { count: 0 },
      pendingVectorJobs: 0,
    });
  });

  it("does not count acknowledged vector writes as failed when a later write in the batch fails", async () => {
    await bookFile("Книга", "01.md", "# Перший\n\nПерший незалежний фрагмент.\n");
    await bookFile("Книга", "02.md", "# Другий\n\nДругий незалежний фрагмент.\n");
    class PartialWriteRepository extends SqliteVectorRepository {
      writes = 0;

      override upsert(
        profileId: string,
        chunkId: string,
        inputHash: string,
        vector: number[],
      ): void {
        if (++this.writes === 2) throw new Error("Simulated second vector write failure");
        super.upsert(profileId, chunkId, inputHash, vector);
      }
    }
    const provider = fakeProvider();
    const vectors = new PartialWriteRepository(join(config.dataDir, "vectors.sqlite"));
    const library = openLibrary({ provider, vectors });

    const failed = await library.index();
    expect(failed).toMatchObject({ embedded: 1, failed: 1 });
    expect(library.status()).toMatchObject({
      chunks: 2,
      vectors: { count: 1 },
      pendingVectorJobs: 1,
      failedVectorJobs: 1,
    });
    expect(await library.embed()).toMatchObject({ embedded: 1, failed: 0 });
    expect(library.status()).toMatchObject({
      vectors: { count: 2 },
      pendingVectorJobs: 0,
      failedVectorJobs: 0,
    });
  });

  it("drops old lexical and vector matches when sources change while the query embedding is pending", async () => {
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
    const searching = reader.search("Застарілий", { mode: "hybrid" });
    await started;
    try {
      await writeFile(source, "# Розділ\n\nОновлений матеріал.\n");
      await writer.index({ embed: false });
    } finally {
      resumeQuery();
    }

    expect((await searching).results).toEqual([]);
    expect((await reader.search("Оновлений", { mode: "lexical" })).results).toHaveLength(1);
  });
});
