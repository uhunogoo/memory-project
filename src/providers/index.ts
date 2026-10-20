import { createHash } from "node:crypto";

import { normalizeBaseUrl } from "../config.js";
import type { EmbeddingConfig, EmbeddingProvider } from "../types.js";

import { ollamaEmbeddingResponseSchema, openAiEmbeddingResponseSchema } from "./schemas.js";

export interface ProviderOptions {
  /** Dependency injection for tests or custom HTTP transports. */
  fetch?: typeof globalThis.fetch;
}

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROTOCOL_VERSION = "embedding-http-v1";
const INVALID_VECTOR_MESSAGE =
  "The embedding server returned an invalid vector: expected finite, nonzero numeric vectors of 1–8192 dimensions.";
const INVALID_INDEXES_MESSAGE =
  "The OpenAI-compatible server returned invalid or duplicate embedding indexes.";

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    const hint =
      status === 401 || status === 403
        ? " Check the configured API key and model access."
        : status === 404
          ? " Check the base URL, model, and whether the server supports embeddings."
          : status === 400 || status === 413 || status === 422
            ? " Check the embedding model, input size, and configured dimensions."
            : "";
    super(`Embedding request failed with HTTP ${status}.${hint}`);
  }
}

class TransportFailure extends Error {}

function endpoint(config: EmbeddingConfig): string {
  const base = normalizeBaseUrl(config.baseUrl);
  if (config.provider === "ollama") {
    if (base.endsWith("/api/embed")) return base;
    return base.endsWith("/api") ? `${base}/embed` : `${base}/api/embed`;
  }
  return base.endsWith("/embeddings") ? base : `${base}/embeddings`;
}

function retryDelay(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, Math.min(5000, duration)) : 0;
}

function extractVectors(
  body: unknown,
  provider: EmbeddingConfig["provider"],
  expected: number,
): number[][] {
  if (provider === "ollama") {
    const response = ollamaEmbeddingResponseSchema.safeParse(body);
    if (!response.success) {
      // Use fixed messages only: Zod diagnostics can contain upstream data.
      const invalidVector = response.error.issues.some(
        (issue) => issue.path[0] === "embeddings" && issue.path.length > 1,
      );
      throw new Error(
        invalidVector
          ? INVALID_VECTOR_MESSAGE
          : "Ollama returned missing or malformed embeddings. Use an embedding-capable model.",
      );
    }
    if (response.data.embeddings.length !== expected) {
      throw new Error(
        "Ollama returned an incorrect embedding count. Use an embedding-capable model.",
      );
    }
    return response.data.embeddings;
  }
  const response = openAiEmbeddingResponseSchema.safeParse(body);
  if (!response.success) {
    if (response.error.issues.some((issue) => issue.path[2] === "index")) {
      throw new Error(INVALID_INDEXES_MESSAGE);
    }
    if (response.error.issues.some((issue) => issue.path[2] === "embedding")) {
      throw new Error(INVALID_VECTOR_MESSAGE);
    }
    throw new Error("The OpenAI-compatible server returned missing or malformed embeddings.");
  }
  if (response.data.data.length !== expected) {
    throw new Error("The OpenAI-compatible server returned an incorrect embedding count.");
  }
  const ordered: number[][] = [];
  const indices = new Set<number>();
  for (const entry of response.data.data) {
    const index = entry.index;
    if (index < 0 || index >= expected || indices.has(index)) {
      throw new Error(INVALID_INDEXES_MESSAGE);
    }
    indices.add(index);
    ordered[index] = entry.embedding;
  }
  return ordered;
}

function validateVector(value: number[], dimensions?: number): number[] {
  if (value.length === 0 || value.length > 8192 || !value.some((number) => number !== 0)) {
    throw new Error(INVALID_VECTOR_MESSAGE);
  }
  if (dimensions !== undefined && value.length !== dimensions) {
    throw new Error(
      "The embedding server returned inconsistent dimensions. Check the configured model and dimensions.",
    );
  }
  return value;
}

function validateRuntimeConfig(config: EmbeddingConfig): void {
  if (!["ollama", "openai-compatible"].includes(config.provider))
    throw new Error("Unsupported embedding provider.");
  if (typeof config.model !== "string" || !config.model.trim())
    throw new Error("An embedding model is required.");
  for (const [name, minimum, maximum] of [
    ["batchSize", 1, 256],
    ["timeoutMs", 100, 600_000],
    ["retries", 0, 5],
  ] as const) {
    if (!Number.isInteger(config[name]) || config[name] < minimum || config[name] > maximum) {
      throw new Error(`Invalid embedding ${name}.`);
    }
  }
  if (
    config.dimensions !== undefined &&
    (!Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 8192)
  ) {
    throw new Error("Invalid embedding dimensions.");
  }
  if (typeof config.documentPrefix !== "string" || typeof config.queryPrefix !== "string") {
    throw new Error("Embedding prefixes must be strings.");
  }
  if (
    config.apiKey !== undefined &&
    (typeof config.apiKey !== "string" || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey))
  ) {
    throw new Error("The embedding API key is invalid.");
  }
}

class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly config: EmbeddingConfig;
  readonly profileId: string;
  private readonly url: string;
  private readonly fetch: typeof globalThis.fetch;
  private observedDimensions: number | undefined;

  constructor(config: EmbeddingConfig, options: ProviderOptions) {
    validateRuntimeConfig(config);
    this.config = Object.freeze({ ...config, baseUrl: normalizeBaseUrl(config.baseUrl) });
    this.url = endpoint(this.config);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.observedDimensions = config.dimensions;
    this.profileId = createHash("sha256")
      .update(
        JSON.stringify({
          protocol: PROTOCOL_VERSION,
          provider: config.provider,
          endpoint: this.url,
          model: config.model,
          dimensions: config.dimensions ?? null,
          documentPrefix: config.documentPrefix,
          queryPrefix: config.queryPrefix,
        }),
      )
      .digest("hex");
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    if (
      !Array.isArray(texts) ||
      texts.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new Error("Embedding inputs must be non-empty strings.");
    }
    if (kind !== "document" && kind !== "query") throw new Error("Invalid embedding input kind.");
    if (texts.length === 0) return [];
    const prefix = kind === "document" ? this.config.documentPrefix : this.config.queryPrefix;
    const input = texts.map((value) => prefix + value);
    const output: number[][] = [];
    let dimensions = this.observedDimensions;
    for (let start = 0; start < input.length; start += this.config.batchSize) {
      const batch = input.slice(start, start + this.config.batchSize);
      const body = await this.request(batch);
      for (const value of extractVectors(body, this.config.provider, batch.length)) {
        const vector = validateVector(value, dimensions);
        dimensions ??= vector.length;
        output.push(vector);
      }
    }
    // Retain dimensions across calls to catch a model changing behind the same endpoint.
    if (this.observedDimensions !== undefined && dimensions !== this.observedDimensions) {
      throw new Error("The embedding model changed dimensions during this operation.");
    }
    this.observedDimensions = dimensions;
    return output;
  }

  private async request(input: string[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(input);
      } catch (error) {
        const transient =
          error instanceof TransportFailure ||
          (error instanceof HttpFailure && TRANSIENT_HTTP.has(error.status));
        if (!transient || attempt >= this.config.retries) throw error;
        const delay = Math.max(
          100 * 2 ** attempt,
          error instanceof HttpFailure ? error.retryAfterMs : 0,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async requestOnce(input: string[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            input,
            ...(this.config.dimensions !== undefined ? { dimensions: this.config.dimensions } : {}),
            ...(this.config.provider === "ollama"
              ? { truncate: false }
              : { encoding_format: "float" }),
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new TransportFailure(
          controller.signal.aborted
            ? "Embedding request timed out."
            : "Unable to connect to the embedding server. Check the base URL and server availability.",
        );
      }
      if (!response.ok) {
        const error = new HttpFailure(
          response.status,
          retryDelay(response.headers.get("retry-after")),
        );
        // Never expose upstream error bodies: they may repeat credentials or book text.
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        if (controller.signal.aborted) throw new TransportFailure("Embedding response timed out.");
        throw new Error("The embedding server returned invalid JSON.");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  options: ProviderOptions = {},
): EmbeddingProvider {
  return new HttpEmbeddingProvider(config, options);
}
