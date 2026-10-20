import { z } from "zod";

// File-format contracts only. Defaults, path resolution, provider requirements and
// numeric limits belong to the configuration logic, not schema refinements.
const embeddingConfigSchema = z.strictObject({
  provider: z.enum(["ollama", "openai-compatible"]),
  baseUrl: z.string().optional(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  dimensions: z.number().int().optional(),
  batchSize: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  retries: z.number().int().optional(),
  documentPrefix: z.string().optional(),
  queryPrefix: z.string().optional(),
});

export const configFileSchema = z.strictObject({
  booksDir: z.string().optional(),
  dataDir: z.string().optional(),
  chunking: z
    .strictObject({
      targetTokens: z.number().int().optional(),
      overlapTokens: z.number().int().optional(),
    })
    .optional(),
  embedding: embeddingConfigSchema.optional(),
});

export type EmbeddingFileConfig = z.infer<typeof embeddingConfigSchema>;
