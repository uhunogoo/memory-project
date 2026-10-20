import { z } from "zod";

export const embeddingInputKindSchema = z.enum(["document", "query"]);
export const embeddingInputSchema = z.object({
  texts: z.array(z.string()),
  kind: embeddingInputKindSchema,
});

export type EmbeddingInputKind = z.infer<typeof embeddingInputKindSchema>;

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
