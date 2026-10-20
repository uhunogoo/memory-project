import type { EmbeddingConfig } from "./schemas/config.js";
import type { EmbeddingInputKind } from "./providers/schemas.js";

export type { AppConfig, ChunkOptions, EmbeddingConfig } from "./schemas/config.js";
export type { IndexOptions } from "./schemas/library.js";
export type { EmbeddingInputKind } from "./providers/schemas.js";

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

export interface StoredChunk extends ParsedChunk {
  documentId: string;
  bookId: string;
  bookTitle: string;
  relativePath: string;
  anchor: string;
}

export interface SearchResult extends StoredChunk {
  score: number;
  matches: ("lexical" | "vector")[];
}
