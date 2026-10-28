import { blob, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { OfficeChunk } from "officeparser";

export const books = sqliteTable( "books", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  source_directory: text("source_directory").notNull().unique()
} );

export const chunks = sqliteTable( "chunks", {
  id: integer("id").primaryKey(),
  book_id: integer("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  source_file: text("source_file").notNull(),
  text: text("text").notNull(),
  startIndex: integer("start_index").notNull(),
  endIndex: integer("end_index").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<OfficeChunk["metadata"]>().notNull(),
},
(table) => [
  uniqueIndex("chunks_book_file_range_unique").on(
    table.book_id,
    table.source_file,
    table.startIndex,
    table.endIndex,
  ),
] );

export const embeddings = sqliteTable("embeddings", {
  id: integer("id").primaryKey(),
  chunkId: integer("chunk_id").notNull().references(() => chunks.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
},
(table) => [
  uniqueIndex("embeddings_chunk_model_dimensions_unique").on(
    table.chunkId,
    table.model,
    table.dimensions,
  ),
] );
