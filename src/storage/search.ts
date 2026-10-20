import type { SearchMode } from "../schemas/search.js";
import type { SearchResult, StoredChunk } from "../types.js";

/** A complete searchable copy of a content chunk, including citation coordinates. */
export type IndexedChunk = StoredChunk;

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  limit: number;
  bookId?: string;
  profileId?: string;
  vector?: number[];
}

export interface SearchResponse {
  mode: SearchMode;
  warnings: string[];
  results: SearchResult[];
}

export interface VectorEntry {
  chunkId: string;
  inputHash: string;
  profileId: string;
}

export interface VectorProfile {
  id: string;
  dimensions: number;
}

/** All retrieval uses this store alone. Enumeration/cache methods are for indexing only. */
export interface SearchRepository {
  upsertChunks(chunks: IndexedChunk[]): Promise<void>;
  ensureProfile(
    profileId: string,
    dimensions: number,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  upsert(profileId: string, chunk: IndexedChunk, vector: number[]): Promise<void>;
  removeChunk(chunkId: string): Promise<void>;
  get(profileId: string, chunkId: string, inputHash: string): Promise<number[] | null>;
  findCached(profileId: string, inputHash: string): Promise<number[] | null>;
  search(request: SearchRequest): Promise<SearchResponse>;
  count(profileId?: string): Promise<number>;
  listProfiles(): Promise<VectorProfile[]>;
  listEntries(): Promise<VectorEntry[]>;
  listChunkIds(): Promise<string[]>;
  close(): Promise<void>;
}
