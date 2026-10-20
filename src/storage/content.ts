import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { DiscoveredBook, ParsedDocument, StoredChunk } from "../types.js";

export interface IndexedSource {
  id: string;
  bookId: string;
  relativePath: string;
  order: number;
  hash: string;
  fingerprint: string;
  markdown: string;
  parsed?: ParsedDocument;
}

export interface VectorJob {
  id: number;
  operation: "upsert" | "delete";
  chunkId: string;
  profileId: string;
  inputHash: string;
  attempts: number;
  lastError: string | null;
}

export interface ContentRepository {
  getChunk(id: string): StoredChunk | null;
  listChunks(bookId?: string): StoredChunk[];
  searchLexical(
    query: string,
    limit: number,
    bookId?: string,
  ): { chunk: StoredChunk; score: number }[];
  close(): void;
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;

export class SqliteContentRepository implements ContentRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.transaction(() => {
        // Inspect under the same write lock as migration: another process may initialize first.
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (version > 1) {
          throw new Error(`Content database schema ${version} is newer than supported version 1.`);
        }
        if (version === 1) return;
        this.db.exec(`
        CREATE TABLE books (
          id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          author TEXT, language TEXT
        );
        CREATE TABLE documents (
          id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL, file_order INTEGER NOT NULL, title TEXT NOT NULL,
          content_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, markdown TEXT NOT NULL,
          UNIQUE(book_id, relative_path)
        );
        CREATE TABLE sections (
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          parent_id TEXT, title TEXT NOT NULL, level INTEGER NOT NULL, anchor TEXT NOT NULL,
          heading_path TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL, markdown TEXT NOT NULL, text TEXT NOT NULL,
          embedding_text TEXT NOT NULL, content_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
          heading_path TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL
        );
        CREATE INDEX chunks_document ON chunks(document_id, ordinal);
        CREATE INDEX sections_document ON sections(document_id, start_offset);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, title, headings, body, tokenize='unicode61');
        CREATE TRIGGER chunks_delete_fts AFTER DELETE ON chunks BEGIN
          DELETE FROM chunks_fts WHERE chunk_id=old.id;
        END;
        CREATE TABLE vector_jobs (
          id INTEGER PRIMARY KEY, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
          chunk_id TEXT NOT NULL, profile_id TEXT NOT NULL, input_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
          UNIQUE(operation, chunk_id, profile_id)
        );
        CREATE TABLE indexing_runs (
          id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL, details TEXT
        );
        CREATE TABLE writer_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acquireWriterLock(): () => void {
    const token = randomUUID();
    this.transaction(() => {
      const lock = this.db.prepare("SELECT * FROM writer_lock WHERE id=1").get();
      if (lock) {
        let alive = true;
        if (lock.host === hostname()) {
          try {
            process.kill(Number(lock.pid), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          }
        }
        if (alive)
          throw new Error(
            `Another indexer holds the database lock (PID ${String(lock.pid)}, host ${String(lock.host)}).`,
          );
      }
      this.db
        .prepare("INSERT OR REPLACE INTO writer_lock VALUES (1,?,?,?)")
        .run(token, process.pid, hostname());
      this.db
        .prepare(
          "UPDATE indexing_runs SET status='interrupted', finished_at=? WHERE status='running'",
        )
        .run(new Date().toISOString());
    });
    return () => {
      this.db.prepare("DELETE FROM writer_lock WHERE token=?").run(token);
    };
  }

  startRun(): number {
    return Number(
      this.db
        .prepare("INSERT INTO indexing_runs(started_at,status) VALUES (?,'running')")
        .run(new Date().toISOString()).lastInsertRowid,
    );
  }

  finishRun(id: number, status: "completed" | "partial" | "failed", details: unknown): void {
    this.db
      .prepare("UPDATE indexing_runs SET status=?,finished_at=?,details=? WHERE id=?")
      .run(status, new Date().toISOString(), JSON.stringify(details), id);
  }

  getDocumentState(id: string): { hash: string; fingerprint: string } | null {
    const row = this.db
      .prepare("SELECT content_hash, fingerprint FROM documents WHERE id=?")
      .get(id);
    return row ? { hash: String(row.content_hash), fingerprint: String(row.fingerprint) } : null;
  }

  applySnapshot(
    books: DiscoveredBook[],
    sources: IndexedSource[],
    profileId?: string,
  ): { updated: number; unchanged: number; removed: number } {
    return this.transaction(() => {
      const result = { updated: 0, unchanged: 0, removed: 0 };
      const sourceIds = new Set(sources.map((source) => source.id));
      for (const row of this.db.prepare("SELECT id FROM documents").all()) {
        if (!sourceIds.has(String(row.id))) {
          this.removeDocument(String(row.id));
          result.removed++;
        }
      }
      const bookIds = new Set(books.map((book) => book.id));
      for (const row of this.db.prepare("SELECT id FROM books").all()) {
        if (!bookIds.has(String(row.id)))
          this.db.prepare("DELETE FROM books WHERE id=?").run(row.id);
      }
      const saveBook = this.db
        .prepare(`INSERT INTO books VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        directory=excluded.directory,title=excluded.title,author=excluded.author,language=excluded.language`);
      for (const book of books)
        saveBook.run(
          book.id,
          book.directory,
          book.title,
          book.author ?? null,
          book.language ?? null,
        );
      for (const source of sources) {
        if (!source.parsed) {
          this.db
            .prepare("UPDATE documents SET file_order=? WHERE id=?")
            .run(source.order, source.id);
          result.unchanged++;
          continue;
        }
        this.removeDocument(source.id);
        this.db
          .prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)")
          .run(
            source.id,
            source.bookId,
            source.relativePath,
            source.order,
            source.parsed.title,
            source.hash,
            source.fingerprint,
            source.markdown,
          );
        const saveSection = this.db.prepare("INSERT INTO sections VALUES (?,?,?,?,?,?,?,?,?,?,?)");
        for (const section of source.parsed.sections)
          saveSection.run(
            section.id,
            source.id,
            section.parentId,
            section.title,
            section.level,
            section.anchor,
            JSON.stringify(section.headingPath),
            section.startOffset,
            section.endOffset,
            section.startLine,
            section.endLine,
          );
        const book = books.find((item) => item.id === source.bookId)!;
        const saveChunk = this.db.prepare(
          "INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        const saveFts = this.db.prepare(
          "INSERT INTO chunks_fts(chunk_id,title,headings,body) VALUES (?,?,?,?)",
        );
        for (const chunk of source.parsed.chunks) {
          saveChunk.run(
            chunk.id,
            source.id,
            chunk.sectionId,
            chunk.ordinal,
            chunk.markdown,
            chunk.text,
            chunk.embeddingText,
            chunk.contentHash,
            chunk.inputHash,
            JSON.stringify(chunk.headingPath),
            chunk.startOffset,
            chunk.endOffset,
            chunk.startLine,
            chunk.endLine,
            chunk.estimatedTokens,
          );
          saveFts.run(chunk.id, book.title, chunk.headingPath.join(" / "), chunk.text);
          // A retained chunk will be reconciled by its input hash; do not delete its reusable vector.
          this.db
            .prepare("DELETE FROM vector_jobs WHERE operation='delete' AND chunk_id=?")
            .run(chunk.id);
          if (profileId) this.enqueueEmbedding(chunk, profileId);
        }
        result.updated++;
      }
      return result;
    });
  }

  private removeDocument(id: string): void {
    for (const row of this.db.prepare("SELECT id FROM chunks WHERE document_id=?").all(id)) {
      this.db
        .prepare("DELETE FROM vector_jobs WHERE operation='upsert' AND chunk_id=?")
        .run(row.id);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO vector_jobs(operation,chunk_id,profile_id,input_hash) VALUES ('delete',?,'*','')",
        )
        .run(row.id);
    }
    this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
  }

  enqueueEmbedding(chunk: Pick<StoredChunk, "id" | "inputHash">, profileId: string): void {
    this.db
      .prepare(`INSERT INTO vector_jobs(operation,chunk_id,profile_id,input_hash) VALUES ('upsert',?,?,?)
      ON CONFLICT(operation,chunk_id,profile_id) DO UPDATE SET input_hash=excluded.input_hash,
      attempts=CASE WHEN vector_jobs.input_hash=excluded.input_hash THEN vector_jobs.attempts ELSE 0 END,
      last_error=CASE WHEN vector_jobs.input_hash=excluded.input_hash THEN vector_jobs.last_error ELSE NULL END`)
      .run(chunk.id, profileId, chunk.inputHash);
  }

  jobs(profileId?: string): VectorJob[] {
    const rows = profileId
      ? this.db
          .prepare(
            "SELECT * FROM vector_jobs WHERE operation='delete' OR profile_id=? ORDER BY operation, id",
          )
          .all(profileId)
      : this.db.prepare("SELECT * FROM vector_jobs ORDER BY operation,id").all();
    return rows.map((row) => ({
      id: Number(row.id),
      operation: row.operation as VectorJob["operation"],
      chunkId: String(row.chunk_id),
      profileId: String(row.profile_id),
      inputHash: String(row.input_hash),
      attempts: Number(row.attempts),
      lastError: row.last_error == null ? null : String(row.last_error),
    }));
  }

  completeJob(id: number): void {
    this.db.prepare("DELETE FROM vector_jobs WHERE id=?").run(id);
  }
  failJob(id: number, error: string): void {
    this.db
      .prepare("UPDATE vector_jobs SET attempts=attempts+1,last_error=? WHERE id=?")
      .run(error, id);
  }

  private chunkFromRow(row: Row): StoredChunk {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      bookId: String(row.book_id),
      bookTitle: String(row.book_title),
      relativePath: String(row.relative_path),
      sectionId: String(row.section_id),
      anchor: String(row.anchor),
      ordinal: Number(row.ordinal),
      markdown: String(row.markdown),
      text: String(row.text),
      embeddingText: String(row.embedding_text),
      contentHash: String(row.content_hash),
      inputHash: String(row.input_hash),
      headingPath: JSON.parse(String(row.heading_path)) as string[],
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      estimatedTokens: Number(row.estimated_tokens),
    };
  }

  private readonly chunkSelect = `SELECT c.*,d.book_id,d.relative_path,b.title AS book_title,s.anchor
    FROM chunks c JOIN documents d ON d.id=c.document_id JOIN books b ON b.id=d.book_id JOIN sections s ON s.id=c.section_id`;

  getChunk(id: string): StoredChunk | null {
    const row = this.db.prepare(`${this.chunkSelect} WHERE c.id=?`).get(id);
    return row ? this.chunkFromRow(row) : null;
  }

  listChunks(bookId?: string): StoredChunk[] {
    const sql = `${this.chunkSelect}${bookId ? " WHERE d.book_id=?" : ""} ORDER BY b.directory,d.file_order,c.ordinal`;
    const rows = bookId ? this.db.prepare(sql).all(bookId) : this.db.prepare(sql).all();
    return rows.map((row) => this.chunkFromRow(row));
  }

  listBooks() {
    return this.db
      .prepare(`SELECT b.*,COUNT(DISTINCT d.id) AS files,COUNT(c.id) AS chunks FROM books b
      LEFT JOIN documents d ON d.book_id=b.id LEFT JOIN chunks c ON c.document_id=d.id GROUP BY b.id ORDER BY b.directory`)
      .all();
  }

  listSections(bookId?: string) {
    return this.db
      .prepare(`SELECT s.*,d.relative_path,d.book_id FROM sections s JOIN documents d ON d.id=s.document_id
      ${bookId ? "WHERE d.book_id=?" : ""} ORDER BY d.book_id,d.file_order,s.start_offset`)
      .all(...(bookId ? [bookId] : []));
  }

  getDocument(id: string) {
    return this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) ?? null;
  }

  searchLexical(
    query: string,
    limit: number,
    bookId?: string,
  ): { chunk: StoredChunk; score: number }[] {
    // Treat user text as terms, never as raw FTS syntax. unicode61 is language neutral, without English stemming.
    const terms = [...new Set(query.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (terms.length === 0) return [];
    const expression = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = this.db
      .prepare(`SELECT c.id,bm25(chunks_fts,0,3,2,1) AS score FROM chunks_fts
      JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN documents d ON d.id=c.document_id
      WHERE chunks_fts MATCH ? ${bookId ? "AND d.book_id=?" : ""} ORDER BY score,c.id LIMIT ?`)
      .all(expression, ...(bookId ? [bookId] : []), limit);
    return rows.map((row) => ({ chunk: this.getChunk(String(row.id))!, score: Number(row.score) }));
  }

  status() {
    const count = (table: string) =>
      Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    return {
      books: count("books"),
      documents: count("documents"),
      sections: count("sections"),
      chunks: count("chunks"),
      pendingVectorJobs: count("vector_jobs"),
      failedVectorJobs: Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM vector_jobs WHERE last_error IS NOT NULL").get()!
          .n,
      ),
      lastRun:
        this.db.prepare("SELECT * FROM indexing_runs ORDER BY id DESC LIMIT 1").get() ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
