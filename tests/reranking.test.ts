import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BookLibrary } from "../src/library.js";
import type { AppConfig, EmbeddingProvider, RerankProvider } from "../src/types.js";

let directory: string;
let config: AppConfig;
const libraries: BookLibrary[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memory-reranking-"));
  config = {
    booksDir: join(directory, "books"),
    dataDir: join(directory, "data"),
    chunking: { targetTokens: 800, overlapTokens: 100 },
  };
  await mkdir(join(config.booksDir, "Book"), { recursive: true });
});

afterEach(async () => {
  for (const library of libraries) library.close();
  libraries.length = 0;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function open(dependencies: ConstructorParameters<typeof BookLibrary>[1] = {}) {
  const library = new BookLibrary(config, dependencies);
  libraries.push(library);
  return library;
}

async function books(count: number, book = "Book") {
  await mkdir(join(config.booksDir, book), { recursive: true });
  for (let index = 0; index < count; index++) {
    await writeFile(
      join(config.booksDir, book, `${index}.md`),
      `# Розділ ${index}\n\nПам'ять зберігає матеріал книги ${book}, фрагмент ${index}.\n`,
    );
  }
}

function reranker() {
  return {
    rerank: vi
      .fn<RerankProvider["rerank"]>()
      .mockImplementation(async (_query, documents) =>
        documents.map((_document, index) => ({ index, score: index === 19 ? 1 : 0 })).reverse(),
      ),
  };
}

function embedding(): EmbeddingProvider {
  return {
    profileId: "rerank-test-embeddings",
    config: {
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "test",
      batchSize: 16,
      timeoutMs: 1000,
      retries: 0,
      documentPrefix: "",
      queryPrefix: "",
    },
    embed: async (texts) => texts.map(() => [1, 0]),
  };
}

describe("search reranking", () => {
  it.each(["lexical", "vector", "hybrid"] as const)(
    "reranks a bounded pool before limiting %s results and keeps citations and book filters",
    async (mode) => {
      await books(45);
      await books(2, "Other");
      const model = reranker();
      const library = open({ reranker: model, provider: embedding() });
      await library.index();
      const bookId = library.content
        .listChunks()
        .find((chunk) => chunk.bookTitle === "Book")!.bookId;
      const baseline = await library.search("матеріал", {
        mode,
        limit: 100,
        bookId,
        rerank: false,
      });
      const contentRead = vi.spyOn(library.content, "listChunks").mockImplementation(() => {
        throw new Error("Reranking must use the search snapshot.");
      });

      const result = await library.search("матеріал", { mode, limit: 2, bookId });

      expect(result.warnings).toEqual([]);
      expect(model.rerank).toHaveBeenCalledExactlyOnceWith(
        "матеріал",
        baseline.results.slice(0, 40).map((chunk) => chunk.embeddingText),
      );
      expect(result.results.map((chunk) => chunk.id)).toEqual([
        baseline.results[0]!.id,
        baseline.results[19]!.id,
      ]);
      expect(result.results[0]).toEqual({
        ...baseline.results[0],
        rrfScore: baseline.results[0]!.score,
        rerankScore: 0,
        score: 0.75,
      });
      expect(result.results[1]).toEqual({
        ...baseline.results[19],
        rrfScore: baseline.results[19]!.score,
        rerankScore: 1,
        score: 0.62,
      });
      expect(contentRead).not.toHaveBeenCalled();
    },
  );

  it("keeps retrieval order, scores and limit when reranking fails without leaking its error", async () => {
    await books(12);
    const model = reranker();
    model.rerank.mockRejectedValue(new Error("private-provider-body secret-key"));
    const library = open({ reranker: model });
    await library.index();
    const baseline = await library.search("матеріал", { mode: "lexical", limit: 3, rerank: false });

    const result = await library.search("матеріал", { mode: "lexical", limit: 3 });

    expect(result.results).toEqual(baseline.results);
    expect(result.warnings).toEqual(["Reranking unavailable; returning retrieval results."]);
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(model.rerank.mock.calls[0]![1]).toHaveLength(12);
  });

  it("skips the provider when disabled or when there are no candidates", async () => {
    await books(1);
    const model = reranker();
    const library = open({ reranker: model });
    await library.index();
    const bypassed = await library.search("матеріал", { mode: "lexical", rerank: false });
    expect(bypassed.results).toHaveLength(1);
    expect(bypassed.results[0]).not.toHaveProperty("rerankScore");
    expect((await library.search("відсутнє", { mode: "lexical" })).results).toEqual([]);
    expect(model.rerank).not.toHaveBeenCalled();
  });

  it("reports an explicitly requested but unconfigured reranker", async () => {
    const library = open();
    await expect(library.search("матеріал", { rerank: true })).rejects.toThrow(
      "Configure a reranker",
    );
  });

  it("uses the configured HTTP model without reindexing and raises the pool to the result limit", async () => {
    await books(8);
    const initial = open();
    await initial.index();
    config.rerank = {
      url: "http://rerank.test/v1/rerank",
      model: "first-model",
      candidateLimit: 3,
      timeoutMs: 1000,
      retries: 0,
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string) as { documents: string[] };
      return new Response(
        JSON.stringify({
          results: body.documents.map((_text, index) => ({ index, relevance_score: 0 })),
        }),
      );
    });
    const first = await open().search("матеріал", { mode: "lexical", limit: 5 });
    expect(first.results).toHaveLength(5);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      model: "first-model",
      top_n: 5,
    });
    config.rerank.model = "replacement-model";
    const replacement = await open().search("матеріал", { mode: "lexical", limit: 2 });
    expect(replacement.results).toHaveLength(2);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
      model: "replacement-model",
      top_n: 3,
    });
  });
});
