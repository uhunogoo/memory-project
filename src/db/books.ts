import { eq, inArray, sql } from "drizzle-orm";
import type { OfficeChunk } from "officeparser";
import type { DatabaseConnection } from "../db/connection.js";
import { books, chunks } from "../db/schema.js";
import { saveRows } from "../db/save-rows.js";

type Db = DatabaseConnection["db"];

type Book = {
  name: string;
  directory: string;
};

export type ParsedFile = {
  source: string;
  chunks: OfficeChunk[];
};

export type ChangedChunk = {
  id: number;
  text: string;
}

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
): ChangedChunk[] {
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
    return saveRows(tx, chunks, rows, {
      target: [
        chunks.book_id,
        chunks.source_file,
        chunks.startIndex,
        chunks.endIndex,
      ],
      set: {
        text: sql`excluded.text`,
        metadata: sql`excluded.metadata`,
      },
      setWhere: sql`
        ${chunks.text} IS NOT excluded.text
        OR ${chunks.metadata} IS NOT excluded.metadata
      `,
    });
  });
}
