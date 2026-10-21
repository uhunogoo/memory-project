import { z } from "zod";
import {
  normalizeRerankUrl,
  rerankConfigSchema,
  validateRerankConfigValues,
  type RerankConfig,
} from "../config.js";
import type { RerankProvider, RerankResult } from "../types.js";

// Cohere-compatible HTTP is also implemented by independent inference servers.
// Provider-specific metadata is accepted without exposing it to the caller.
const rerankResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      relevance_score: z.number(),
    }),
  ),
});

interface ProviderOptions {
  /** Dependency injection for tests or custom HTTP transports. */
  fetch?: typeof globalThis.fetch;
}

const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const INVALID_RESPONSE_MESSAGE =
  "The rerank server returned invalid results: expected one unique index per document and finite relevance scores between 0 and 1.";

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    const hint =
      status === 401 || status === 403
        ? " Check the configured API key and model access."
        : status === 404
          ? " Check the rerank endpoint URL and model."
          : status === 400 || status === 413 || status === 422
            ? " Check the rerank model and input size."
            : "";
    super(`Rerank request failed with HTTP ${status}.${hint}`);
  }
}

class TransportFailure extends Error {}

function retryDelay(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, Math.min(5000, duration)) : 0;
}

function extractResults(body: unknown, expected: number): RerankResult[] {
  const response = rerankResponseSchema.safeParse(body);
  if (!response.success || response.data.results.length !== expected) {
    // Schema diagnostics may contain input text or credentials from upstream.
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
  const ordered: RerankResult[] = [];
  const indexes = new Set<number>();
  for (const { index, relevance_score: score } of response.data.results) {
    if (index < 0 || index >= expected || indexes.has(index) || score < 0 || score > 1) {
      throw new Error(INVALID_RESPONSE_MESSAGE);
    }
    indexes.add(index);
    ordered[index] = { index, score };
  }
  return ordered;
}

class HttpRerankProvider implements RerankProvider {
  private readonly config: RerankConfig;
  private readonly fetch: typeof globalThis.fetch;

  constructor(config: RerankConfig, options: ProviderOptions) {
    const parsed = rerankConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        "Invalid rerank configuration structure. Check field types and required values.",
      );
    }
    validateRerankConfigValues(parsed.data);
    this.config = Object.freeze({ ...parsed.data, url: normalizeRerankUrl(parsed.data.url) });
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("The rerank query must be a non-empty string.");
    }
    if (!Array.isArray(documents)) {
      throw new Error("Rerank documents must be non-empty strings.");
    }
    // Snapshot the batch so a caller cannot alter a pending retry's input or count.
    const input = [...documents];
    if (input.some((document) => typeof document !== "string" || !document.trim())) {
      throw new Error("Rerank documents must be non-empty strings.");
    }
    if (input.length === 0) return [];
    return extractResults(await this.request(query, input), input.length);
  }

  private async request(query: string, documents: string[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(query, documents);
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

  private async requestOnce(query: string, documents: string[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetch(this.config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            query,
            documents,
            top_n: documents.length,
          }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new TransportFailure(
          controller.signal.aborted
            ? "Rerank request timed out."
            : "Unable to connect to the rerank server. Check the endpoint URL and server availability.",
        );
      }
      if (!response.ok) {
        const error = new HttpFailure(
          response.status,
          retryDelay(response.headers.get("retry-after")),
        );
        // Discard upstream errors, which can echo credentials, queries, or book text.
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        if (controller.signal.aborted) throw new TransportFailure("Rerank response timed out.");
        throw new Error("The rerank server returned invalid JSON.");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Uses a full endpoint URL and a model name; no vendor SDK or endpoint suffix is required. */
export function createRerankProvider(
  config: RerankConfig,
  options: ProviderOptions = {},
): RerankProvider {
  return new HttpRerankProvider(config, options);
}
