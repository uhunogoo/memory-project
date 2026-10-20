import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { configFileSchema } from "./schemas/config.js";
import type { EmbeddingFileConfig } from "./schemas/config.js";
import type { AppConfig, EmbeddingConfig } from "./types.js";

function text(value: string | undefined, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validatePrefix(value: string, field: string): void {
  if (value.length > 16_384 || value.includes("\0")) {
    throw new Error(`${field} must be a string of at most 16384 characters.`);
  }
}

/** Business rules shared by file loading and the public provider factory, after parsing. */
export function validateEmbeddingConfigValues(config: EmbeddingConfig): void {
  text(config.model, "embedding.model");
  integer(config.batchSize, "embedding.batchSize", 1, 256);
  integer(config.timeoutMs, "embedding.timeoutMs", 100, 600_000);
  integer(config.retries, "embedding.retries", 0, 5);
  if (config.dimensions !== undefined) {
    integer(config.dimensions, "embedding.dimensions", 1, 8192);
  }
  validatePrefix(config.documentPrefix, "embedding.documentPrefix");
  validatePrefix(config.queryPrefix, "embedding.queryPrefix");
  if (config.apiKey !== undefined && (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey))) {
    throw new Error("The embedding API key is missing or invalid.");
  }
}

/** Validate URLs without exposing embedded credentials in an error. */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("embedding.baseUrl must be an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("embedding.baseUrl must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "embedding.baseUrl must not contain credentials, query parameters, or a fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function embeddingConfig(embedding: EmbeddingFileConfig): EmbeddingConfig {
  const config: EmbeddingConfig = {
    provider: embedding.provider,
    baseUrl: normalizeBaseUrl(
      text(
        embedding.baseUrl,
        "embedding.baseUrl",
        embedding.provider === "ollama" ? "http://127.0.0.1:11434" : undefined,
      ),
    ),
    model: embedding.model,
    batchSize: embedding.batchSize ?? 16,
    timeoutMs: embedding.timeoutMs ?? 60_000,
    retries: embedding.retries ?? 2,
    documentPrefix: embedding.documentPrefix ?? "",
    queryPrefix: embedding.queryPrefix ?? "",
  };
  if (embedding.dimensions !== undefined) {
    config.dimensions = embedding.dimensions;
  }
  if (embedding.apiKeyEnv !== undefined) {
    const variable = text(embedding.apiKeyEnv, "embedding.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw new Error("embedding.apiKeyEnv must name a valid environment variable.");
    }
    const key = process.env[variable];
    if (key === undefined) {
      throw new Error(
        "The environment variable configured by embedding.apiKeyEnv is missing or invalid.",
      );
    }
    config.apiKey = key;
  }
  validateEmbeddingConfigValues(config);
  return config;
}

/** Paths in an explicit config are relative to that file, regardless of the caller's cwd. */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const path = resolve(configPath ?? "memory.config.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (configPath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
      source = "{}";
    } else {
      throw new Error("Unable to read the configuration file. Verify its path and permissions.");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The configuration file must contain valid JSON.");
  }
  const validation = configFileSchema.safeParse(parsed);
  if (!validation.success) {
    // Paths contain schema-defined fields only; never expose Zod's raw issues or input values.
    const field = validation.error.issues[0]?.path.join(".") || "configuration";
    throw new Error(
      `Invalid configuration structure at ${field}. Check field types and supported keys.`,
    );
  }
  const raw = validation.data;
  const chunking = raw.chunking ?? {};
  const targetTokens = integer(chunking.targetTokens ?? 800, "chunking.targetTokens", 64, 16_384);
  const overlapTokens = integer(
    chunking.overlapTokens ?? Math.min(100, Math.floor(targetTokens / 8)),
    "chunking.overlapTokens",
    0,
    targetTokens - 1,
  );
  const config: AppConfig = {
    booksDir: resolve(dirname(path), text(raw.booksDir, "booksDir", "books")),
    dataDir: resolve(dirname(path), text(raw.dataDir, "dataDir", ".data")),
    chunking: { targetTokens, overlapTokens },
  };
  if (raw.embedding !== undefined) config.embedding = embeddingConfig(raw.embedding);
  return config;
}
