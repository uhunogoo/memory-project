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

function integer(
  value: number | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = value === undefined ? fallback : value;
  if (number < minimum || number > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function prefix(value: string | undefined, field: string): string {
  if (value === undefined) return "";
  if (value.length > 16_384 || value.includes("\0")) {
    throw new Error(`${field} must be a string of at most 16384 characters.`);
  }
  return value;
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
    model: text(embedding.model, "embedding.model"),
    batchSize: integer(embedding.batchSize, "embedding.batchSize", 16, 1, 256),
    timeoutMs: integer(embedding.timeoutMs, "embedding.timeoutMs", 60_000, 100, 600_000),
    retries: integer(embedding.retries, "embedding.retries", 2, 0, 5),
    documentPrefix: prefix(embedding.documentPrefix, "embedding.documentPrefix"),
    queryPrefix: prefix(embedding.queryPrefix, "embedding.queryPrefix"),
  };
  if (embedding.dimensions !== undefined) {
    config.dimensions = integer(embedding.dimensions, "embedding.dimensions", 0, 1, 8192);
  }
  if (embedding.apiKeyEnv !== undefined) {
    const variable = text(embedding.apiKeyEnv, "embedding.apiKeyEnv");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw new Error("embedding.apiKeyEnv must name a valid environment variable.");
    }
    const key = process.env[variable];
    if (!key || key.trim().length === 0 || /[\r\n]/.test(key)) {
      throw new Error(
        "The environment variable configured by embedding.apiKeyEnv is missing or invalid.",
      );
    }
    config.apiKey = key;
  }
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
  const targetTokens = integer(chunking.targetTokens, "chunking.targetTokens", 800, 64, 16_384);
  const overlapTokens = integer(
    chunking.overlapTokens,
    "chunking.overlapTokens",
    Math.min(100, Math.floor(targetTokens / 8)),
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
