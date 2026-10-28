import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
    sqlite.pragma("foreign_keys = ON");

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });

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
