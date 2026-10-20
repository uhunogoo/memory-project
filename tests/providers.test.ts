import { describe, expect, it, vi } from "vite-plus/test";

import { createEmbeddingProvider } from "../src/providers/index.js";
import type { EmbeddingConfig } from "../src/types.js";

function config(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "test-embedding",
    batchSize: 2,
    timeoutMs: 1000,
    retries: 0,
    documentPrefix: "",
    queryPrefix: "",
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embedding providers", () => {
  it("batches Ollama inputs without truncation and preserves source text with its prefix", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          embeddings: [
            [1, 0],
            [0, 1],
          ],
        }),
      )
      .mockResolvedValueOnce(json({ embeddings: [[1, 1]] }));
    const provider = createEmbeddingProvider(
      config({ documentPrefix: "passage: ", dimensions: 2 }),
      { fetch },
    );
    const source = [" Українська книга\n", "Розділ другий", "Третій"];
    await expect(provider.embed(source, "document")).resolves.toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(source[0]).toBe(" Українська книга\n");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/embed");
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      model: "test-embedding",
      input: ["passage:  Українська книга\n", "passage: Розділ другий"],
      dimensions: 2,
      truncate: false,
    });
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string).input).toEqual(["passage: Третій"]);
  });

  it("orders OpenAI-compatible vectors by indexes and sends query prefix plus authentication", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const provider = createEmbeddingProvider(
      config({
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1/",
        apiKey: "secret",
        queryPrefix: "query: ",
      }),
      { fetch },
    );
    await expect(provider.embed(["first", "second"], "query")).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/embeddings");
    expect(options?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      model: "test-embedding",
      input: ["query: first", "query: second"],
      encoding_format: "float",
    });
    expect(options?.redirect).toBe("error");
  });

  it("returns an empty result without a request when no inputs are supplied", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createEmbeddingProvider(config(), { fetch }).embed([], "document"),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "ollama" as const,
      body: {
        model: "server-model",
        total_duration: 123,
        embeddings: [[1, 2]],
        vendor_metadata: { any: ["shape", null] },
      },
    },
    {
      provider: "openai-compatible" as const,
      body: {
        object: "list",
        model: "server-model",
        usage: { prompt_tokens: 3 },
        data: [{ object: "embedding", index: 0, embedding: [1, 2], vendor_metadata: true }],
      },
    },
  ])("accepts optional provider metadata for $provider", async ({ provider, body }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
    await expect(
      createEmbeddingProvider(config({ provider }), { fetch }).embed(["text"], "query"),
    ).resolves.toEqual([[1, 2]]);
  });

  it.each([
    ["ollama", null],
    ["ollama", []],
    ["ollama", { embeddings: null }],
    ["ollama", { embeddings: { 0: [1, 2] } }],
    ["ollama", { embeddings: [null] }],
    ["ollama", { embeddings: ["private-secret book contents"] }],
    ["ollama", { embeddings: [[true, 2]] }],
    ["openai-compatible", null],
    ["openai-compatible", { data: {} }],
    ["openai-compatible", { data: [null] }],
    ["openai-compatible", { data: ["private-secret book contents"] }],
    ["openai-compatible", { data: [{ index: 0 }] }],
    ["openai-compatible", { data: [{ index: 0, embedding: null }] }],
    ["openai-compatible", { data: [{ index: 0, embedding: ["private-secret book contents"] }] }],
    ["openai-compatible", { data: [{ index: "0", embedding: [1] }] }],
    ["openai-compatible", { data: [{ index: 0.5, embedding: [1] }] }],
    ["openai-compatible", { data: [{ index: null, embedding: [1] }] }],
  ] satisfies [EmbeddingConfig["provider"], unknown][])(
    "rejects malformed %s payloads without retrying or exposing payload details %#",
    async (provider, body) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
      const result = createEmbeddingProvider(config({ provider, retries: 3 }), { fetch }).embed(
        ["text"],
        "query",
      );
      await expect(result).rejects.toThrow("returned");
      await expect(result).rejects.not.toThrow("private-secret");
      await expect(result).rejects.not.toHaveProperty("issues");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("binds profiles to embedding semantics but excludes credentials and HTTP tuning", () => {
    const original = createEmbeddingProvider(config({ apiKey: "secret-one" })).profileId;
    expect(
      createEmbeddingProvider(
        config({ apiKey: "secret-two", batchSize: 10, retries: 1, timeoutMs: 2000 }),
      ).profileId,
    ).toBe(original);
    expect(
      createEmbeddingProvider(config({ baseUrl: "http://127.0.0.1:11434/api/embed/" })).profileId,
    ).toBe(original);
    for (const change of [
      { model: "another" },
      { dimensions: 3 },
      { documentPrefix: "passage: " },
      { queryPrefix: "query: " },
      { baseUrl: "http://127.0.0.1:11435" },
    ])
      expect(createEmbeddingProvider(config(change)).profileId).not.toBe(original);
  });

  it("freezes the copied configuration so callers cannot change profile semantics", () => {
    const original = config();
    const provider = createEmbeddingProvider(original);
    original.model = "different";
    expect(provider.config.model).toBe("test-embedding");
    expect(Object.isFrozen(provider.config)).toBe(true);
  });

  it.each([
    { embeddings: [] },
    { output: [[1, 0]] },
    { embeddings: [[]] },
    { embeddings: [[0, 0]] },
    { embeddings: [[null, 1]] },
    { embeddings: [["1", 2]] },
    { embeddings: [[1], [2]] },
  ])("rejects missing, malformed, and zero vectors %#", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(response));
    await expect(
      createEmbeddingProvider(config(), { fetch }).embed(["text"], "document"),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [2] },
      ],
    },
    {
      data: [
        { index: 1, embedding: [1] },
        { index: 2, embedding: [2] },
      ],
    },
    {
      data: [
        { index: -1, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    },
    { data: [{ embedding: [1] }, { index: 1, embedding: [2] }] },
  ])("rejects ambiguous OpenAI-compatible response ordering %#", async ({ data }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ data }));
    await expect(
      createEmbeddingProvider(config({ provider: "openai-compatible" }), { fetch }).embed(
        ["one", "two"],
        "query",
      ),
    ).rejects.toThrow("indexes");
  });

  it("detects changed dimensions across batches and later calls", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ embeddings: [[1, 2]] }))
      .mockResolvedValueOnce(json({ embeddings: [[1, 2, 3]] }));
    const provider = createEmbeddingProvider(config({ batchSize: 1 }), { fetch });
    await expect(provider.embed(["one", "two"], "document")).rejects.toThrow("dimensions");
    const nextFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ embeddings: [[1, 2]] }))
      .mockResolvedValueOnce(json({ embeddings: [[1, 2, 3]] }));
    const nextProvider = createEmbeddingProvider(config(), { fetch: nextFetch });
    await nextProvider.embed(["one"], "document");
    await expect(nextProvider.embed(["two"], "query")).rejects.toThrow("dimensions");
  });

  it("checks configured dimensions and non-finite vector components", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ embeddings: [[1, 2]] }));
    await expect(
      createEmbeddingProvider(config({ dimensions: 3 }), { fetch }).embed(["text"], "query"),
    ).rejects.toThrow("dimensions");
    const response = json({});
    vi.spyOn(response, "json").mockResolvedValue({ embeddings: [[1, Number.POSITIVE_INFINITY]] });
    const invalidFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(
      createEmbeddingProvider(config(), { fetch: invalidFetch }).embed(["text"], "query"),
    ).rejects.toThrow("invalid vector");
  });

  it.each(["ollama", "openai-compatible"] as const)(
    "enforces vector size, nonzero values, and batch count after parsing %s responses",
    async (provider) => {
      for (const vectors of [[], [[]], [[0, 0]], [Array<number>(8193).fill(1)], [[1], [2]]]) {
        const body =
          provider === "ollama"
            ? { embeddings: vectors }
            : { data: vectors.map((embedding, index) => ({ index, embedding })) };
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
        await expect(
          createEmbeddingProvider(config({ provider }), { fetch }).embed(["text"], "query"),
        ).rejects.toThrow(vectors.length === 1 ? "invalid vector" : "embedding count");
      }
    },
  );

  it("retries a transient server failure then returns the successful result", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ error: "upstream error" }, 503))
      .mockResolvedValueOnce(json({ embeddings: [[1, 0]] }));
    await expect(
      createEmbeddingProvider(config({ retries: 1 }), { fetch }).embed(["text"], "query"),
    ).resolves.toEqual([[1, 0]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never retries permanent errors or exposes upstream messages", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ error: "private-secret book contents" }, 401));
    const result = createEmbeddingProvider(config({ retries: 3 }), { fetch }).embed(
      ["text"],
      "query",
    );
    await expect(result).rejects.toThrow("HTTP 401");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds connection retries and hides transport errors that might include secrets", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("private-secret"));
    const result = createEmbeddingProvider(config({ retries: 1 }), { fetch }).embed(
      ["text"],
      "query",
    );
    await expect(result).rejects.toThrow("Unable to connect");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts timed-out requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    await expect(
      createEmbeddingProvider(config({ timeoutMs: 100 }), { fetch }).embed(["text"], "query"),
    ).rejects.toThrow("timed out");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("does not retry malformed successful responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not JSON"));
    await expect(
      createEmbeddingProvider(config({ retries: 3 }), { fetch }).embed(["text"], "query"),
    ).rejects.toThrow("invalid JSON");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
