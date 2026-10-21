import { z } from "zod";
import type { RerankResult, SearchResult } from "./types.js";

export const rerankStrategySchema = z.enum(["score", "blend"]);
export type RerankStrategy = z.infer<typeof rerankStrategySchema>;

/** Rank one scored candidate pool; equal scores keep the original retrieval order. */
export function rankRerankedResults(
  candidates: SearchResult[],
  scores: RerankResult[],
  strategy: RerankStrategy = "score",
): SearchResult[] {
  if (strategy !== "score" && strategy !== "blend") {
    throw new Error("Rerank strategy must be score or blend.");
  }
  const indexes = new Set<number>();
  if (
    scores.length !== candidates.length ||
    scores.some(({ index, score }) => {
      const invalid =
        !Number.isInteger(index) ||
        index < 0 ||
        index >= candidates.length ||
        indexes.has(index) ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1;
      indexes.add(index);
      return invalid;
    }) ||
    indexes.size !== candidates.length
  ) {
    throw new Error("Reranking requires one valid score per candidate.");
  }
  return scores
    .map(({ index, score }) => {
      const candidate = candidates[index]!;
      const retrievalRank = index + 1;
      // Keep QMD's previous formula available for comparison on the same pool.
      const weight = retrievalRank <= 3 ? 0.75 : retrievalRank <= 10 ? 0.6 : 0.4;
      return {
        ...candidate,
        rrfScore: candidate.score,
        rerankScore: score,
        retrievalRank,
        score: strategy === "score" ? score : weight / retrievalRank + (1 - weight) * score,
      };
    })
    .sort((a, b) => b.score - a.score || a.retrievalRank - b.retrievalRank);
}
