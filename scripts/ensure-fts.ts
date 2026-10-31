
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const sqlite = new Database("./.data/memory.sqlite");

try {
  const required = [
    "chunks_fts",
    "chunks_fts_insert",
    "chunks_fts_delete",
    "chunks_fts_update",
  ];

  const objects = sqlite
    .prepare(`
      SELECT name FROM sqlite_schema
      WHERE (type = 'table' AND name = 'chunks_fts')
         OR (type = 'trigger' AND name IN (
           'chunks_fts_insert',
           'chunks_fts_delete',
           'chunks_fts_update'
         ))
    `)
    .all() as { name: string }[];

  const existing = new Set(objects.map((obj) => obj.name));
  const needsRepair = required.some((name) => !existing.has(name));

  if (needsRepair) {
    const sql = readFileSync(
      new URL("../src/db/sql/fts.sql", import.meta.url),
      "utf8",
    );

    sqlite.transaction(() => {
      sqlite.exec(sql);
    })();

    console.log("FTS5 repaired");
  } else {
    console.log("FTS5 OK");
  }
} finally {
  sqlite.close();
}
