import { eq, inArray, sql } from "drizzle-orm";
import type { OfficeChunk } from "officeparser";
import type { DatabaseConnection } from "./db.js";
import { books, chunks } from "../schemas/schema.js";

type Db = DatabaseConnection["db"];

type Book = {
  name: string;
  directory: string;
};

export type ParsedFile = {
  source: string;
  chunks: OfficeChunk[];
};

const BATCH_SIZE = 100;

export function cleanBookChunks(
  db: Db,
  bookDirectory: string
): number {
  const matchingBook = db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.source_directory, bookDirectory));

  return db
    .delete(chunks)
    .where(inArray(chunks.book_id, matchingBook))
    .run()
    .changes;
}

export function saveBook(
  db: Db,
  book: Book,
  files: ParsedFile[],
): number {
  return db.transaction((tx) => {
    const savedBook = tx
      .insert(books)
      .values({
        title: book.name,
        source_directory: book.directory,
      })
      .onConflictDoUpdate({
        target: books.source_directory,
        set: { title: book.name },
      })
      .returning({ id: books.id })
      .get();

    if (!savedBook) {
      throw new Error(`Не вдалося зберегти книгу: ${book.name}`);
    }

    // Structure chunks to schema
    const rows: (typeof chunks.$inferInsert)[] = files.flatMap((file) =>
      file.chunks.map((chunk) => ({
        book_id: savedBook.id,
        source_file: file.source,
        text: chunk.text,
        startIndex: chunk.startIndex!,
        endIndex: chunk.endIndex!,
        metadata: chunk.metadata,
      })),
    );

    // Upsert chunks
    let changedCount = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const changed = tx
        .insert(chunks)
        .values(rows.slice(i, i + BATCH_SIZE))
        .onConflictDoUpdate({
          target: [
            chunks.book_id,
            chunks.source_file,
            chunks.startIndex,
            chunks.endIndex,
          ],
          // Upsert logic
          set: {
            text: sql`excluded.text`,
            metadata: sql`excluded.metadata`,
          },
          setWhere: sql`
            ${chunks.text} IS NOT excluded.text
            OR ${chunks.metadata} IS NOT excluded.metadata
          `,
        })
        .returning({ id: chunks.id })
        .all();

       changedCount += changed.length;
    }

    return changedCount;
  });
}
