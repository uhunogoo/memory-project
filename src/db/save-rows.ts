import type {
  SQLiteInsert,
  SQLiteInsertOnConflictDoUpdateConfig,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import type { DatabaseConnection } from "./connection.js";

type Db = DatabaseConnection["db"];

type Conflict<T extends SQLiteTable> =
  SQLiteInsertOnConflictDoUpdateConfig<SQLiteInsert<T>>;

const DB_BATCH_SIZE = 100;

export function saveRows<T extends SQLiteTable>(
  db: Db,
  table: T,
  rows: NoInfer<T>["$inferInsert"][],
  onConflict?: Conflict<T>,
): T["$inferSelect"][] {
  if (rows.length === 0) return [];

  return db.transaction((tx) => {
    const savedRows: T["$inferSelect"][] = [];

    for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
      const query = tx
        .insert(table)
        .values(rows.slice(i, i + DB_BATCH_SIZE));

      if (onConflict) {
        query.onConflictDoUpdate(onConflict);
      }

      const saved = query
        .returning()
        .all() as T["$inferSelect"][];

      savedRows.push(...saved);
    }

    return savedRows;
  });
}
