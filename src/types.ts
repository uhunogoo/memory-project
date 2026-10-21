import type { EmbeddingConfig } from "./config.js";

export type { AppConfig, ChunkOptions, EmbeddingConfig, RerankConfig } from "./config.js";
export type { IndexOptions } from "./library.js";
export type EmbeddingInputKind = "document" | "query";

export interface SourceFile {
  relativePath: string;
  markdown: string;
  order: number;
}

export interface DiscoveredBook {
  id: string;
  directory: string;
  title: string;
  author?: string;
  language?: string;
  files: SourceFile[];
}

export interface DiscoveryResult {
  books: DiscoveredBook[];
  warnings: string[];
}

export interface ParsedSection {
  id: string;
  parentId: string | null;
  title: string;
  level: number;
  anchor: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface ParsedChunk {
  id: string;
  sectionId: string;
  ordinal: number;
  markdown: string;
  text: string;
  embeddingText: string;
  contentHash: string;
  inputHash: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  estimatedTokens: number;
}

export interface ParsedDocument {
  title: string;
  sections: ParsedSection[];
  chunks: ParsedChunk[];
}

export interface EmbeddingProvider {
  readonly profileId: string;
  readonly config: EmbeddingConfig;
  embed(texts: string[], kind: EmbeddingInputKind): Promise<number[][]>;
}

export interface RerankResult {
  /** Zero-based position in the submitted documents. */
  index: number;
  /** Relevance score between 0 and 1. */
  score: number;
}

export interface RerankProvider {
  /** Return exactly one score per document; response order is unrestricted. */
  rerank(query: string, documents: string[]): Promise<RerankResult[]>;
}

export interface StoredChunk extends ParsedChunk {
  documentId: string;
  bookId: string;
  bookTitle: string;
  relativePath: string;
  anchor: string;
}

export interface SearchResult extends StoredChunk {
  /** RRF score, or the position-aware blend when rerankScore is present. */
  score: number;
  rrfScore?: number;
  rerankScore?: number;
  matches: ("lexical" | "vector")[];
}
