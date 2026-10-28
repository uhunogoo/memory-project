import { asc, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../connection.js";
import { chunks } from "../schema.js";

export function ftsSearch(db: DatabaseConnection["db"], query: string, limit: number) {
  // Terms preparation
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const normalizeTerms = terms.map((term) => term.toLowerCase());
  const uniqueTerms = [...new Set(normalizeTerms)];
  const ftsQuery = uniqueTerms.map((term) => `"${term}"`).join(" OR ");

  if (!ftsQuery) return [];

  return db
    .select({
      id: chunks.id,
      text: chunks.text,
      sourceFile: chunks.source_file,
    })
    .from(chunks)
    .innerJoin(sql`chunks_fts`, sql`${chunks.id} = chunks_fts.rowid`)
    .where(sql`chunks_fts MATCH ${ftsQuery}`)
    .orderBy(asc(sql`bm25(chunks_fts)`), asc(chunks.id))
    .limit(limit)
    .all();
}
