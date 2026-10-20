import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { parseMarkdown } from "../src/ingestion/markdown.js";
import { SqliteContentRepository } from "../src/storage/content.js";

describe("content schema migration", () => {
  it("removes the legacy FTS index while preserving content and pending delivery jobs", () => {
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
        "model",
      );
      // The v1 content schema differs only by its FTS table and deletion trigger.
      for (const job of content.jobs()) {
        if (job.profileId === "*") content.completeJob(job.id);
      }
      const chunks = content.listChunks();
      const jobs = content.jobs();
      content.close();
      const raw = new DatabaseSync(path);
      try {
        raw.exec(`
          CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, title, headings, body, tokenize='unicode61');
          CREATE TRIGGER chunks_delete_fts AFTER DELETE ON chunks BEGIN
            DELETE FROM chunks_fts WHERE chunk_id=old.id;
          END;
          INSERT INTO chunks_fts SELECT id, '', '', text FROM chunks;
          PRAGMA user_version=1;
        `);
      } finally {
        raw.close();
      }
      content = new SqliteContentRepository(path);
      expect(content.listChunks()).toEqual(chunks);
      expect(content.jobs()).toEqual(jobs);
      expect(content.getDocument("document")?.markdown).toBe(markdown);
      const migrated = new DatabaseSync(path);
      try {
        expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
        expect(
          migrated
            .prepare(
              "SELECT name FROM sqlite_master WHERE name LIKE 'chunks_fts%' OR name='chunks_delete_fts'",
            )
            .all(),
        ).toEqual([]);
      } finally {
        migrated.close();
      }
      // The old trigger must not survive to break subsequent source deletions.
      expect(content.applySnapshot([], [], "model")).toMatchObject({ removed: 1 });
      expect(content.jobs().some((job) => job.operation === "delete")).toBe(true);
    } finally {
      content.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
