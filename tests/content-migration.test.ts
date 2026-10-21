import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { parseMarkdown } from "../src/ingestion/markdown.js";
import { SqliteContentRepository } from "../src/storage/content.js";

describe("content schema migration", () => {
  it("removes the v2 outbox while preserving content and the latest run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "content-migration-"));
    const path = join(directory, "content.sqlite");
    let content = new SqliteContentRepository(path);
    try {
      const markdown = "# Архів\n\nЗбережений текст документа.\n";
      const parsed = parseMarkdown("document", markdown, "Книга", {
        targetTokens: 800,
        overlapTokens: 100,
      });
      content.applySnapshot(
        [{ id: "book", title: "Книга", directory: "book", files: [] }],
        [
          {
            id: "document",
            bookId: "book",
            relativePath: "chapter.md",
            order: 0,
            hash: "source-hash",
            fingerprint: "chunker",
            markdown,
            parsed,
          },
        ],
      );
      const chunks = content.listChunks();
      content.close();
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`
          CREATE TABLE vector_jobs(id INTEGER PRIMARY KEY, operation TEXT, chunk_id TEXT, profile_id TEXT, input_hash TEXT, attempts INTEGER, last_error TEXT);
          INSERT INTO vector_jobs VALUES (1,'upsert','obsolete','model','hash',1,'failure');
          INSERT INTO indexing_runs(id,started_at,status) VALUES (2,'old','completed'),(3,'latest','partial');
          PRAGMA user_version=2;
        `);
      } finally {
        raw.close();
      }
      content = new SqliteContentRepository(path);
      expect(content.listChunks()).toEqual(chunks);
      expect(content.status().lastRun).toMatchObject({ started_at: "latest", status: "partial" });
      expect(content.getDocument("document")?.markdown).toBe(markdown);
      const migrated = new DatabaseSync(path);
      try {
        expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
        expect(
          migrated.prepare("SELECT name FROM sqlite_master WHERE name='vector_jobs'").all(),
        ).toEqual([]);
      } finally {
        migrated.close();
      }
      expect(content.applySnapshot([], [])).toMatchObject({ removed: 1 });
      expect(content.listChunks()).toEqual([]);
      await content.withIndexingRun(async () => ({ failed: 0 }), "Indexing failed");
      await content.withIndexingRun(async () => {
        expect(content.status().lastRun).toMatchObject({ id: 1, status: "running", details: null });
        return { failed: 0 };
      }, "Indexing failed");
    } finally {
      content.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
