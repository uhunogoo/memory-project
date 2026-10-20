import { z } from "zod";
import { chunkOptionsSchema } from "../schemas/config.js";

// Validate the external formats; file existence, traversal and duplicate checks
// remain in discovery. Unknown frontmatter metadata is allowed for book compatibility.
export const bookManifestSchema = z.strictObject({
  title: z.string().optional(),
  author: z.string().optional(),
  language: z.string().optional(),
  files: z.array(z.string()).optional(),
});

export const frontmatterSchema = z.object({ title: z.string().optional() });

export const parseMarkdownInputSchema = z.object({
  documentId: z.string(),
  markdown: z.string(),
  bookTitle: z.string(),
  options: chunkOptionsSchema,
});

export type BookManifest = z.infer<typeof bookManifestSchema>;
