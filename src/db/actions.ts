import { eq } from "drizzle-orm";
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

    // Прибираємо також застарілі чанки після зміни або видалення файлів.
    tx.delete(chunks)
      .where(eq(chunks.book_id, savedBook.id))
      .run();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      tx.insert(chunks)
        .values(rows.slice(i, i + BATCH_SIZE))
        .run();
    }

    return rows.length;
  });
}
