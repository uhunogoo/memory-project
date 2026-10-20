import { z } from "zod";

// These describe the HTTP payload only. Unknown provider metadata is accepted
// and omitted from the parsed result; vector semantics are checked by the adapter.
const vectorSchema = z.array(z.number());

export const ollamaEmbeddingResponseSchema = z.object({
  embeddings: z.array(vectorSchema),
});

export const openAiEmbeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int(),
      embedding: vectorSchema,
    }),
  ),
});
