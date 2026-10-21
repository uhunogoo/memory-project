import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  loadConfig,
  normalizeRerankUrl,
  rerankConfigSchema,
  validateRerankConfigValues,
} from "../src/config.js";
import { createEmbeddingProvider } from "../src/providers/index.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memory-config-"));
  for (const variable of [
    "RERANK_URL",
    "RERANK_MODEL",
    "RERANK_API_KEY",
    "COHERE_RERANK_URL",
    "COHERE_RERANK_MODEL",
    "COHERE_RERANK_API_KEY",
  ]) {
    vi.stubEnv(variable, undefined);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function configFile(value: unknown): Promise<string> {
  const path = join(directory, "memory.config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("configuration", () => {
  it("works without the optional default file and resolves paths from cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    await expect(loadConfig()).resolves.toEqual({
      booksDir: join(directory, "books"),
      dataDir: join(directory, ".data"),
      chunking: { targetTokens: 800, overlapTokens: 100 },
    });
  });

  it("requires an explicitly requested file to exist", async () => {
    await expect(loadConfig(join(directory, "missing.json"))).rejects.toThrow("Unable to read");
  });

  it("resolves paths relative to the configuration file and keeps Unicode prefixes exact", async () => {
    vi.stubEnv("MEMORY_TEST_API_KEY", "secret-token");
    const path = await configFile({
      booksDir: "./texts",
      dataDir: "../index",
      chunking: { targetTokens: 1200, overlapTokens: 150 },
      embedding: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1/",
        model: "multilingual",
        apiKeyEnv: "MEMORY_TEST_API_KEY",
        dimensions: 384,
        documentPrefix: "passage: ",
        queryPrefix: "запит: ",
      },
    });
    const config = await loadConfig(path);
    expect(config.booksDir).toBe(join(directory, "texts"));
    expect(config.dataDir).toBe(join(directory, "../index"));
    expect(config.chunking).toEqual({ targetTokens: 1200, overlapTokens: 150 });
    expect(config.embedding).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      model: "multilingual",
      apiKey: "secret-token",
      dimensions: 384,
      batchSize: 16,
      timeoutMs: 60_000,
      retries: 2,
      documentPrefix: "passage: ",
      queryPrefix: "запит: ",
    });
  });

  it("uses local Ollama defaults when embeddings are configured", async () => {
    const config = await loadConfig(
      await configFile({ embedding: { provider: "ollama", model: "local-embed" } }),
    );
    expect(config.embedding?.baseUrl).toBe("http://127.0.0.1:11434");
    expect(config.embedding?.apiKey).toBeUndefined();
  });

  it("scales the default overlap down for a smaller target", async () => {
    const config = await loadConfig(await configFile({ chunking: { targetTokens: 64 } }));
    expect(config.chunking).toEqual({ targetTokens: 64, overlapTokens: 8 });
  });

  it.each([
    [{ chunking: { targetTokens: "800" } }, "chunking.targetTokens"],
    [{ chunking: [] }, "chunking"],
    [{ embedding: { provider: "ollama", model: ["private-input"] } }, "embedding.model"],
    [{ embedding: { provider: "ollama", model: "test", batchSize: "16" } }, "embedding.batchSize"],
    [{ chunking: { privateKey: "private-input" } }, "chunking"],
  ])(
    "rejects invalid input structure without coercion or leaking values %#",
    async (value, field) => {
      const result = loadConfig(await configFile(value));
      await expect(result).rejects.toThrow(`Invalid configuration structure at ${field}`);
      await expect(result).rejects.not.toThrow("private-input");
      await expect(result).rejects.not.toThrow("privateKey");
    },
  );

  it("checks relationships and provider requirements after structural parsing", async () => {
    await expect(
      loadConfig(await configFile({ chunking: { targetTokens: 64, overlapTokens: 64 } })),
    ).rejects.toThrow("chunking.overlapTokens must be an integer between 0 and 63");
    await expect(
      loadConfig(await configFile({ embedding: { provider: "openai-compatible", model: "test" } })),
    ).rejects.toThrow("embedding.baseUrl must be a non-empty string");
    await expect(
      loadConfig(
        await configFile({ embedding: { provider: "ollama", model: "test", dimensions: 8193 } }),
      ),
    ).rejects.toThrow("embedding.dimensions must be an integer between 1 and 8192");
  });

  it.each([
    [{ model: "embed\0" }, "embedding.model"],
    [{ documentPrefix: "prefix\0" }, "embedding.documentPrefix"],
    [{ queryPrefix: "x".repeat(16_385) }, "embedding.queryPrefix"],
    [{ batchSize: 257 }, "embedding.batchSize"],
    [{ timeoutMs: 99 }, "embedding.timeoutMs"],
    [{ retries: 6 }, "embedding.retries"],
    [{ dimensions: 8193 }, "embedding.dimensions"],
  ])(
    "applies the same embedding business rules to file and programmatic inputs %#",
    async (overrides, field) => {
      const embedding = { provider: "ollama", model: "embed" };
      const valid = await loadConfig(await configFile({ embedding }));
      const path = await configFile({ embedding: { ...embedding, ...overrides } });
      await expect(loadConfig(path)).rejects.toThrow(field);
      expect(() => createEmbeddingProvider({ ...valid.embedding!, ...overrides })).toThrow(field);
    },
  );

  it.each(["", " \t", "private-secret\n"])(
    "rejects invalid credentials from env and direct calls without exposing them %#",
    async (apiKey) => {
      const valid = await loadConfig(
        await configFile({ embedding: { provider: "ollama", model: "embed" } }),
      );
      vi.stubEnv("MEMORY_TEST_API_KEY", apiKey);
      const path = await configFile({
        embedding: { provider: "ollama", model: "embed", apiKeyEnv: "MEMORY_TEST_API_KEY" },
      });
      const result = loadConfig(path);
      await expect(result).rejects.toThrow("missing or invalid");
      await expect(result).rejects.not.toThrow("private-secret");
      const create = () => createEmbeddingProvider({ ...valid.embedding!, apiKey });
      expect(create).toThrow("missing or invalid");
      expect(create).not.toThrow("private-secret");
    },
  );

  it.each([
    null,
    [],
    { booksDir: "" },
    { dataDir: 12 },
    { unknown: true },
    { chunking: { targetTokens: 0 } },
    { chunking: { targetTokens: 800.5 } },
    { chunking: { overlapTokens: 800 } },
    { chunking: { overlapTokens: -1 } },
    { embedding: null },
    { embedding: { provider: "different", model: "test" } },
    { embedding: { provider: "ollama" } },
    { embedding: { provider: "openai-compatible", model: "test" } },
    { embedding: { provider: "ollama", model: "test", dimensions: 0 } },
    { embedding: { provider: "ollama", model: "test", dimensions: 8193 } },
    { embedding: { provider: "ollama", model: "test", batchSize: 0 } },
    { embedding: { provider: "ollama", model: "test", retries: 6 } },
    { embedding: { provider: "ollama", model: "test", timeoutMs: 0 } },
    { embedding: { provider: "ollama", model: "test", queryPrefix: null } },
    { embedding: { provider: "ollama", model: "test", baseUrl: "file:///tmp/index" } },
    {
      embedding: { provider: "ollama", model: "test", baseUrl: "https://example.test?key=secret" },
    },
    {
      embedding: { provider: "ollama", model: "test", baseUrl: "https://user:secret@example.test" },
    },
    { embedding: { provider: "ollama", model: "test", apiKey: "literal-secret" } },
  ])("rejects invalid or ambiguous configuration %#", async (value) => {
    const path = await configFile(value);
    await expect(loadConfig(path)).rejects.toThrow();
  });

  it("does not echo malformed JSON, unknown fields, or credentials in errors", async () => {
    const path = join(directory, "memory.config.json");
    await writeFile(path, '{"apiKey":"private-secret"');
    await expect(loadConfig(path)).rejects.not.toThrow("private-secret");
    await configFile({ "private-secret": "token" });
    await expect(loadConfig(path)).rejects.not.toThrow("private-secret");
    await configFile({
      embedding: {
        provider: "ollama",
        model: "embed",
        baseUrl: "https://user:private-secret@example.test",
      },
    });
    await expect(loadConfig(path)).rejects.not.toThrow("private-secret");
  });

  it("fails explicitly when a configured credential environment variable is missing", async () => {
    vi.stubEnv("MEMORY_MISSING_API_KEY", undefined);
    const path = await configFile({
      embedding: { provider: "ollama", model: "embed", apiKeyEnv: "MEMORY_MISSING_API_KEY" },
    });
    await expect(loadConfig(path)).rejects.toThrow("missing or invalid");
  });
});

describe("rerank configuration", () => {
  it("enables reranking from the existing Cohere environment variables without a config file", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.stubEnv("COHERE_RERANK_URL", "https://example.test/v2/rerank");
    vi.stubEnv("COHERE_RERANK_MODEL", "rerank-multilingual");
    vi.stubEnv("COHERE_RERANK_API_KEY", "test-key");
    const config = await loadConfig();
    expect(config.rerank).toEqual({
      url: "https://example.test/v2/rerank",
      model: "rerank-multilingual",
      apiKey: "test-key",
      candidateLimit: 40,
      timeoutMs: 60_000,
      retries: 2,
    });
  });

  it("prefers generic environment settings and falls back per field", async () => {
    vi.stubEnv("COHERE_RERANK_URL", "https://old.example.test/v2/rerank");
    vi.stubEnv("COHERE_RERANK_MODEL", "fallback-model");
    vi.stubEnv("COHERE_RERANK_API_KEY", "fallback-key");
    vi.stubEnv("RERANK_URL", "http://127.0.0.1:8080/rerank/");
    vi.stubEnv("RERANK_API_KEY", "generic-key");
    const path = await configFile({});
    expect((await loadConfig(path)).rerank).toMatchObject({
      url: "http://127.0.0.1:8080/rerank/",
      model: "fallback-model",
      apiKey: "generic-key",
    });
    vi.stubEnv("RERANK_MODEL", "generic-model");
    expect((await loadConfig(path)).rerank?.model).toBe("generic-model");
  });

  it("allows a config file to override endpoint, model, credentials, and request limits", async () => {
    vi.stubEnv("RERANK_URL", "https://old.example.test/rerank");
    vi.stubEnv("RERANK_MODEL", "old-model");
    vi.stubEnv("RERANK_API_KEY", "old-key");
    vi.stubEnv("MEMORY_TEST_RERANK_KEY", "configured-key");
    const config = await loadConfig(
      await configFile({
        rerank: {
          url: "https://new.example.test/api/rerank/",
          model: "new-model",
          apiKeyEnv: "MEMORY_TEST_RERANK_KEY",
          candidateLimit: 75,
          timeoutMs: 10_000,
          retries: 0,
        },
      }),
    );
    expect(config.rerank).toEqual({
      url: "https://new.example.test/api/rerank/",
      model: "new-model",
      apiKey: "configured-key",
      candidateLimit: 75,
      timeoutMs: 10_000,
      retries: 0,
    });
  });

  it("allows local endpoints without an API key and keeps the complete path", async () => {
    const config = await loadConfig(
      await configFile({ rerank: { url: "http://localhost:8080/custom/rerank", model: "local" } }),
    );
    expect(config.rerank?.url).toBe("http://localhost:8080/custom/rerank");
    expect(config.rerank?.apiKey).toBeUndefined();
  });

  it("stays disabled with no settings, including an empty config object", async () => {
    expect((await loadConfig(await configFile({}))).rerank).toBeUndefined();
    expect((await loadConfig(await configFile({ rerank: {} }))).rerank).toBeUndefined();
  });

  it("lets explicit false disable even invalid environment settings", async () => {
    vi.stubEnv("RERANK_URL", "private-invalid-url");
    vi.stubEnv("RERANK_API_KEY", "private-secret\n");
    expect((await loadConfig(await configFile({ rerank: false }))).rerank).toBeUndefined();
  });

  it.each([
    [{ rerank: { model: "model" } }, "rerank.url"],
    [{ rerank: { url: "https://example.test/rerank" } }, "rerank.model"],
    [{ rerank: { candidateLimit: 40 } }, "rerank.url"],
  ])("rejects partial file settings clearly %#", async (value, field) => {
    await expect(loadConfig(await configFile(value))).rejects.toThrow(field);
  });

  it.each([
    ["RERANK_URL", "https://example.test/rerank", "rerank.model"],
    ["COHERE_RERANK_MODEL", "model", "rerank.url"],
    ["RERANK_API_KEY", "private-secret", "rerank.url"],
  ])(
    "rejects partial environment settings without exposing values %#",
    async (variable, value, field) => {
      vi.stubEnv(variable, value);
      const result = loadConfig(await configFile({}));
      await expect(result).rejects.toThrow(field);
      await expect(result).rejects.not.toThrow("private-secret");
    },
  );

  it.each([
    { candidateLimit: 0 },
    { candidateLimit: 101 },
    { timeoutMs: 99 },
    { timeoutMs: 600_001 },
    { retries: -1 },
    { retries: 6 },
    { model: " \t" },
    { model: "private-secret\0" },
  ])(
    "shares numeric and model business rules with programmatic configuration %#",
    async (overrides) => {
      const rerank = { url: "https://example.test/rerank", model: "model" };
      const valid = (await loadConfig(await configFile({ rerank }))).rerank!;
      const result = loadConfig(await configFile({ rerank: { ...rerank, ...overrides } }));
      await expect(result).rejects.toThrow(`rerank.${Object.keys(overrides)[0]}`);
      expect(() => validateRerankConfigValues({ ...valid, ...overrides })).toThrow(
        `rerank.${Object.keys(overrides)[0]}`,
      );
      await expect(result).rejects.not.toThrow("private-secret");
    },
  );

  it.each([
    "private-secret",
    "/rerank/private-secret",
    "file:///private-secret",
    "https://user:private-secret@example.test/rerank",
    "https://@example.test/rerank",
    "https://example.test/rerank?key=private-secret",
    "https://example.test/rerank#private-secret",
    "https://example.test/rerank?",
    "https://example.test/rerank#",
    "https://example.test/\nprivate-secret",
    "https:example.test/private-secret",
  ])("rejects invalid endpoint URLs without leaking values %#", async (url) => {
    const result = loadConfig(await configFile({ rerank: { url, model: "model" } }));
    await expect(result).rejects.toThrow("rerank.url");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(() => normalizeRerankUrl(url)).toThrow("rerank.url");
    expect(() => normalizeRerankUrl(url)).not.toThrow("private-secret");
  });

  it.each(["", " \t", "private-secret\n"])(
    "rejects invalid credential values without exposing them %#",
    async (apiKey) => {
      vi.stubEnv("RERANK_URL", "https://example.test/rerank");
      vi.stubEnv("RERANK_MODEL", "model");
      const valid = (await loadConfig(await configFile({}))).rerank!;
      vi.stubEnv("RERANK_API_KEY", apiKey);
      const result = loadConfig(await configFile({}));
      await expect(result).rejects.toThrow("missing or invalid");
      await expect(result).rejects.not.toThrow("private-secret");
      const validate = () => validateRerankConfigValues({ ...valid, apiKey });
      expect(validate).toThrow("missing or invalid");
      expect(validate).not.toThrow("private-secret");
    },
  );

  it("rejects NUL bytes in programmatic credentials without exposing them", async () => {
    const config = await loadConfig(
      await configFile({ rerank: { url: "http://localhost:8080/rerank", model: "local" } }),
    );
    const validate = () =>
      validateRerankConfigValues({ ...config.rerank!, apiKey: "private-secret\0" });
    expect(validate).toThrow("missing or invalid");
    expect(validate).not.toThrow("private-secret");
  });

  it.each(["", "private-secret-key", "123INVALID", "PRIVATE\0SECRET"])(
    "rejects invalid credential variable names without exposing them %#",
    async (apiKeyEnv) => {
      const result = loadConfig(
        await configFile({
          rerank: { url: "https://example.test/rerank", model: "model", apiKeyEnv },
        }),
      );
      await expect(result).rejects.toThrow("rerank.apiKeyEnv");
      await expect(result).rejects.not.toThrow("private-secret");
    },
  );

  it("requires an explicitly selected credential variable even when a default key exists", async () => {
    vi.stubEnv("RERANK_API_KEY", "default-key");
    vi.stubEnv("MEMORY_MISSING_RERANK_KEY", undefined);
    const result = loadConfig(
      await configFile({
        rerank: {
          url: "https://example.test/rerank",
          model: "model",
          apiKeyEnv: "MEMORY_MISSING_RERANK_KEY",
        },
      }),
    );
    await expect(result).rejects.toThrow("rerank.apiKeyEnv is missing or invalid");
  });

  it.each([
    true,
    null,
    [],
    { model: ["private-secret"] },
    { apiKey: "private-secret" },
    { "private-secret": true },
    { candidateLimit: "40" },
    { candidateLimit: 40.5 },
  ])(
    "rejects invalid file structures without echoing unknown fields or values %#",
    async (rerank) => {
      const result = loadConfig(await configFile({ rerank }));
      await expect(result).rejects.toThrow("Invalid configuration structure at rerank");
      await expect(result).rejects.not.toThrow("private-secret");
    },
  );

  it("keeps structural parsing separate from numeric business limits", () => {
    const result = rerankConfigSchema.safeParse({
      url: "https://example.test/rerank",
      model: "model",
      candidateLimit: 0,
      timeoutMs: 60_000,
      retries: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(() => validateRerankConfigValues(result.data)).toThrow("rerank.candidateLimit");
    }
  });
});
