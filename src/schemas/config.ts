import { z } from "zod";

// Structural contracts only. Defaults, path resolution, provider requirements and
// numeric limits belong to the configuration logic, not schema refinements.
export const chunkOptionsSchema = z.object({
  targetTokens: z.number().int(),
  overlapTokens: z.number().int(),
});

export const embeddingConfigSchema = z.object({
  provider: z.enum(["ollama", "openai-compatible"]),
  baseUrl: z.string(),
  model: z.string(),
  apiKey: z.string().optional(),
  dimensions: z.number().int().optional(),
  batchSize: z.number().int(),
  timeoutMs: z.number().int(),
  retries: z.number().int(),
  documentPrefix: z.string(),
  queryPrefix: z.string(),
});

const embeddingFileConfigSchema = z.strictObject({
  ...embeddingConfigSchema.omit({ apiKey: true }).partial({
    baseUrl: true,
    batchSize: true,
    timeoutMs: true,
    retries: true,
    documentPrefix: true,
    queryPrefix: true,
  }).shape,
  apiKeyEnv: z.string().optional(),
});

export const configFileSchema = z.strictObject({
  booksDir: z.string().optional(),
  dataDir: z.string().optional(),
  chunking: z.strictObject(chunkOptionsSchema.partial().shape).optional(),
  embedding: embeddingFileConfigSchema.optional(),
});

export type ChunkOptions = z.infer<typeof chunkOptionsSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type EmbeddingFileConfig = z.infer<typeof embeddingFileConfigSchema>;
