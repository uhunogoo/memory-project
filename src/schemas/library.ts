import { z } from "zod";

// Only the public call's structure; the default embedding behavior stays in index().
export const indexOptionsSchema = z.object({
  embed: z.boolean().optional(),
});

export type IndexOptions = z.infer<typeof indexOptionsSchema>;
