import { reranker } from "../../helpers/reranker.js";
import type { DatabaseConnection } from "../connection.js";
import { ftsSearch } from "./fts-search.js";
import { vectorSearch } from "./vector-search.js";

export type SearchResult = ReturnType<typeof ftsSearch>[number] & {
  score: number;
};

const RRF_K = 60;

export async function hybridSearch(
  db: DatabaseConnection["db"],
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  query = query.trim();
  if (!query) return [];

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit має бути додатним цілим числом");
  }

  const candidateLimit = Math.max(12, limit * 5);

  const vectorHits = await vectorSearch(db, query, candidateLimit);
  const textHits = ftsSearch(db, query, candidateLimit);

  // Scoring
  const merged = new Map<number, SearchResult>();
  const scoring = (
    hit: (typeof textHits)[number],
    index: number
  ) => {
    const previous = merged.get(hit.id);
    const score = (previous?.score ?? 0) + 1 / (RRF_K + index + 1);
    merged.set(hit.id, { ...hit, score });
  };

  textHits.forEach(scoring);
  vectorHits.forEach(scoring);

  // Result
  const mergedResults = [...merged.values()];
  const results = await reranker(query, mergedResults);

  return results
    .slice(0, limit)
    .map(({ chunk, score }) => ({ ...chunk, score }));
}
