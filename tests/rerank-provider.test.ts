import { describe, expect, it, vi } from "vite-plus/test";

import type { RerankConfig } from "../src/config.js";
import { createRerankProvider } from "../src/providers/rerank.js";

function config(overrides: Partial<RerankConfig> = {}): RerankConfig {
  return {
    url: "https://example.test/v2/rerank",
    model: "test-reranker",
    candidateLimit: 40,
    timeoutMs: 1000,
    retries: 0,
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HTTP rerank provider", () => {
  it("uses the complete endpoint and Cohere-compatible contract with optional authentication", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        id: "response-id",
        meta: { billed_units: { search_units: 1 } },
        results: [
          { index: 1, relevance_score: 0.9, document: { text: "ignored" } },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    );
    const provider = createRerankProvider(
      config({
        url: "https://example.test/custom/rank/",
        model: "replacement-model",
        apiKey: "secret",
      }),
      { fetch },
    );
    const documents = [" Перша книга\n", "Друга книга"];
    const result = await provider.rerank(" Український запит ", documents);
    expect(result).toEqual([
      { index: 0, score: 0.2 },
      { index: 1, score: 0.9 },
    ]);
    expect(documents).toEqual([" Перша книга\n", "Друга книга"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/custom/rank/");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(options?.body as string)).toEqual({
      model: "replacement-model",
      query: " Український запит ",
      documents,
      top_n: 2,
    });
  });

  it("allows unauthenticated endpoints and boundary scores", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        results: [
          { index: 0, relevance_score: 0 },
          { index: 1, relevance_score: 1 },
        ],
      }),
    );
    await expect(
      createRerankProvider(config(), { fetch }).rerank("query", ["one", "two"]),
    ).resolves.toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 1 },
    ]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
  });

  it("does not send a request for an empty document list", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createRerankProvider(config(), { fetch }).rerank("query", [])).resolves.toEqual(
      [],
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, 1, "", " \n"])("rejects invalid queries before HTTP %#", async (query) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createRerankProvider(config(), { fetch }).rerank(query as string, ["text"]),
    ).rejects.toThrow("query must be a non-empty string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, [null], [""], ["valid", " \n"], [123], Array<string>(1)])(
    "rejects invalid documents before HTTP %#",
    async (documents) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        createRerankProvider(config(), { fetch }).rerank("query", documents as string[]),
      ).rejects.toThrow("documents must be non-empty strings");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    { results: null },
    { results: {} },
    { results: [] },
    { results: [null] },
    { results: ["private-secret book text"] },
    { results: [{ index: 0 }] },
    { results: [{ relevance_score: 0.5 }] },
    { results: [{ index: "0", relevance_score: 0.5 }] },
    { results: [{ index: 0.5, relevance_score: 0.5 }] },
    { results: [{ index: -1, relevance_score: 0.5 }] },
    { results: [{ index: 1, relevance_score: 0.5 }] },
    { results: [{ index: 0, relevance_score: "private-secret" }] },
    { results: [{ index: 0, relevance_score: null }] },
    { results: [{ index: 0, relevance_score: -0.01 }] },
    { results: [{ index: 0, relevance_score: 1.01 }] },
    {
      results: [
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.2 },
      ],
    },
  ])("rejects invalid result contracts without retrying or exposing payloads %#", async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(body));
    const result = createRerankProvider(config({ retries: 3 }), { fetch }).rerank("query", [
      "text",
    ]);
    await expect(result).rejects.toThrow("invalid results");
    await expect(result).rejects.not.toThrow("private-secret");
    await expect(result).rejects.not.toHaveProperty("issues");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite scores %#",
    async (score) => {
      const response = json({});
      vi.spyOn(response, "json").mockResolvedValue({
        results: [{ index: 0, relevance_score: score }],
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      await expect(
        createRerankProvider(config(), { fetch }).rerank("query", ["text"]),
      ).rejects.toThrow("invalid results");
    },
  );

  it.each([
    [
      { index: 0, relevance_score: 0.7 },
      { index: 0, relevance_score: 0.5 },
    ],
    [
      { index: 1, relevance_score: 0.7 },
      { index: 2, relevance_score: 0.5 },
    ],
    [{ index: 1, relevance_score: 0.7 }],
  ])("requires a complete unique permutation of document indexes %#", async (...results) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ results }));
    await expect(
      createRerankProvider(config(), { fetch }).rerank("query", ["one", "two"]),
    ).rejects.toThrow("invalid results");
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    "retries transient HTTP %s responses",
    async (status) => {
      const response = json({ error: "private-secret" }, status);
      const cancel = vi.spyOn(response.body!, "cancel");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(json({ results: [{ index: 0, relevance_score: 0.6 }] }));
      await expect(
        createRerankProvider(config({ retries: 1 }), { fetch }).rerank("query", ["text"]),
      ).resolves.toEqual([{ index: 0, score: 0.6 }]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 401, 403, 404, 413, 422])(
    "does not retry HTTP %s or expose upstream errors",
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json({ error: "private-secret" }, status));
      const result = createRerankProvider(config({ retries: 3 }), { fetch }).rerank("query", [
        "text",
      ]);
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      await expect(result).rejects.not.toThrow("private-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds retries and sanitizes transport errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("private-secret"));
    const result = createRerankProvider(config({ retries: 1 }), { fetch }).rerank("query", [
      "text",
    ]);
    await expect(result).rejects.toThrow("Unable to connect");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("respects bounded Retry-After before a retry", async () => {
    vi.useFakeTimers();
    try {
      const response = json({}, 429);
      response.headers.set("retry-after", "120");
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(json({ results: [{ index: 0, relevance_score: 0.8 }] }));
      const result = createRerankProvider(config({ retries: 1 }), { fetch }).rerank("query", [
        "text",
      ]);
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual([{ index: 0, score: 0.8 }]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts timed-out requests without exposing transport errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("private-secret")), {
            once: true,
          });
        }),
    );
    const result = createRerankProvider(config({ timeoutMs: 100 }), { fetch }).rerank("query", [
      "text",
    ]);
    await expect(result).rejects.toThrow("timed out");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps the timeout active while receiving a successful response body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
      const response = json({});
      vi.spyOn(response, "json").mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("private-secret")), {
              once: true,
            });
          }),
      );
      return response;
    });
    await expect(
      createRerankProvider(config({ timeoutMs: 100 }), { fetch }).rerank("query", ["text"]),
    ).rejects.toThrow("response timed out");
  });

  it("does not retry invalid JSON or expose response parsing errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("private-secret"));
    const result = createRerankProvider(config({ retries: 3 }), { fetch }).rerank("query", [
      "text",
    ]);
    await expect(result).rejects.toThrow("invalid JSON");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("copies the configuration and documents so caller changes cannot alter retries", async () => {
    const source = config({ retries: 1 });
    const documents = ["original"];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ results: [{ index: 0, relevance_score: 0.5 }] }));
    const provider = createRerankProvider(source, { fetch });
    source.url = "https://different.test/rerank";
    source.model = "different";
    const result = provider.rerank("query", documents);
    documents[0] = "changed";
    documents.push("extra");
    await expect(result).resolves.toEqual([{ index: 0, score: 0.5 }]);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe("https://example.test/v2/rerank");
      expect(JSON.parse(options?.body as string)).toEqual({
        model: "test-reranker",
        query: "query",
        documents: ["original"],
        top_n: 1,
      });
    }
  });

  it.each([
    { model: null },
    { url: null },
    { timeoutMs: "1000" },
    { timeoutMs: Number.NaN },
    { retries: 0.5 },
    { candidateLimit: 1.5 },
    { apiKey: 123 },
  ])(
    "validates the public factory configuration structure without exposing values %#",
    (overrides) => {
      expect(() => createRerankProvider({ ...config(), ...overrides } as RerankConfig)).toThrow(
        "Invalid rerank configuration structure",
      );
    },
  );

  it("rejects credential-bearing URLs with safe errors before HTTP", () => {
    expect(() =>
      createRerankProvider(config({ url: "https://private-secret@example.test/rerank" })),
    ).toThrow("must not contain");
    expect(() =>
      createRerankProvider(config({ url: "https://private-secret@example.test/rerank" })),
    ).not.toThrow("private-secret");
  });
});
