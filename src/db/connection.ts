import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import * as schema from "./schema.js";

export type DatabaseConnection = {
  db: BetterSQLite3Database<typeof schema>;
  close: () => void;
};

export function openDatabase(): DatabaseConnection {
  const databasePath = fileURLToPath(
    new URL("../.data/memory.sqlite", import.meta.url),
  );

  const migrationsFolder = fileURLToPath(
    new URL("../drizzle/", import.meta.url),
  );

  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);

  try {
    sqlite.pragma("foreign_keys = OFF");
    sqliteVec.load(sqlite);

    const db = drizzle(sqlite, { schema });

    try {
      migrate(db, { migrationsFolder });
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    return {
      db,
      close: () => {
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
