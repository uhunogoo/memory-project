import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SqliteContentRepository } from "../src/storage/content.js";

let directory: string;
let content: SqliteContentRepository;
let raw: DatabaseSync;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "indexing-run-"));
  const path = join(directory, "content.sqlite");
  content = new SqliteContentRepository(path);
  raw = new DatabaseSync(path);
});

afterEach(() => {
  raw.close();
  content.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("indexing run lifetime", () => {
  it.each([
    [0, "completed"],
    [2, "partial"],
  ] as const)("records a report with %i failures as %s", async (failed, status) => {
    const report = { failed, embedded: 3, warnings: ["example"] };
    const result = await content.withIndexingRun(async () => {
      expect(content.status().lastRun).toMatchObject({ status: "running", finished_at: null });
      // A second connection can write: the run does not hold a SQL transaction.
      raw.exec("CREATE TABLE concurrent_write (id INTEGER)");
      return report;
    }, "Indexing failed");
    expect(result).toBe(report);
    expect(content.status().lastRun).toMatchObject({ status, details: JSON.stringify(report) });
    expect(raw.prepare("SELECT * FROM writer_lock").all()).toEqual([]);
  });

  it.each([new Error("Work failed"), "non-Error failure"])(
    "records failure, rethrows the original value, and permits retry: %s",
    async (error) => {
      await expect(
        content.withIndexingRun(async () => {
          throw error;
        }, "Embedding failed"),
      ).rejects.toBe(error);
      expect(content.status().lastRun).toMatchObject({
        status: "failed",
        details: JSON.stringify({
          error: error instanceof Error ? error.message : "Embedding failed",
        }),
      });
      await expect(
        content.withIndexingRun(async () => ({ failed: 0 }), "Indexing failed"),
      ).resolves.toEqual({ failed: 0 });
    },
  );

  it("releases the lock when run creation fails without invoking work", async () => {
    raw.exec(`CREATE TRIGGER reject_run BEFORE INSERT ON indexing_runs
      BEGIN SELECT RAISE(ABORT, 'Run creation failed'); END`);
    const work = vi.fn(async () => ({ failed: 0 }));
    await expect(content.withIndexingRun(work, "Indexing failed")).rejects.toThrow(
      "Run creation failed",
    );
    expect(work).not.toHaveBeenCalled();
    expect(content.status().lastRun).toBeNull();
    raw.exec("DROP TRIGGER reject_run");
    await expect(content.withIndexingRun(work, "Indexing failed")).resolves.toEqual({ failed: 0 });
  });

  it("releases the lock even when recording the outcome fails", async () => {
    raw.exec(`CREATE TRIGGER reject_outcome BEFORE UPDATE ON indexing_runs
      BEGIN SELECT RAISE(ABORT, 'Run update failed'); END`);
    await expect(
      content.withIndexingRun(async () => ({ failed: 0 }), "Indexing failed"),
    ).rejects.toThrow("Run update failed");
    raw.exec("DROP TRIGGER reject_outcome");
    await expect(
      content.withIndexingRun(async () => ({ failed: 0 }), "Indexing failed"),
    ).resolves.toEqual({ failed: 0 });
  });
});
