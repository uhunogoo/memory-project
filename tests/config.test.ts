import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadConfig } from "../src/config.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memory-config-"));
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
