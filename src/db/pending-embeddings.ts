import { and, eq, notExists, sql } from "drizzle-orm";

import { config } from "../config.js";
import { books, chunks, embeddings } from "./schema.js";
import type { DatabaseConnection } from "./connection.js";

type Db = DatabaseConnection["db"];

export function findPendingEmbeddings(
  db: Db,
  bookDirectory: string,
) {
  const { model, dimensions } = config.embedding;
  if (!model) {
    throw new Error("Не задано EMBEDDING_MODEL");
  }

  const matchingEmbedding = db
    .select({ exists: sql<number>`1` })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.chunkId, chunks.id),
        eq(embeddings.model, model),
        eq(embeddings.dimensions, dimensions),
      ),
    );

  return db
    .select({
      id: chunks.id,
      text: chunks.text,
    })
    .from(chunks)
    .innerJoin(books, eq(books.id, chunks.book_id))
    .where(
      and(
        eq(books.source_directory, bookDirectory),
        notExists(matchingEmbedding),
      ),
    )
    .orderBy(chunks.chunkIndex, chunks.id)
    .all();
}
