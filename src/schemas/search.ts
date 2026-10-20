import { z } from "zod";

export const searchModeSchema = z.enum(["lexical", "vector", "hybrid"]);

export const searchOptionsSchema = z.object({
  mode: searchModeSchema.optional(),
  limit: z.number().int().optional(),
  bookId: z.string().optional(),
});

// Public input structure only; defaults and query/limit policies stay in the library.
export const searchInputSchema = z.object({
  query: z.string(),
  options: searchOptionsSchema,
});

export type SearchMode = z.infer<typeof searchModeSchema>;
export type SearchOptions = z.infer<typeof searchOptionsSchema>;
