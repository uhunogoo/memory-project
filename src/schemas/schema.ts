import { blob, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { OfficeChunk } from "officeparser";

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<OfficeChunk["metadata"]>().notNull(),
    startIndex: integer("start_index"),
    endIndex: integer("end_index"),
  },
  (table) => [uniqueIndex("chunks_source_position_unique").on(table.source, table.position)],
);

export const chunkEmbeddings = sqliteTable("chunk_embeddings", {
  chunkId: integer("chunk_id")
    .primaryKey()
    .references(() => chunks.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
});
