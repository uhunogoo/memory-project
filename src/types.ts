export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

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

export interface EmbeddingConfig {
  provider: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimensions?: number;
  batchSize: number;
  timeoutMs: number;
  retries: number;
  documentPrefix: string;
  queryPrefix: string;
}

export interface EmbeddingProvider {
  readonly profileId: string;
  readonly config: EmbeddingConfig;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

export interface AppConfig {
  booksDir: string;
  dataDir: string;
  chunking: ChunkOptions;
  embedding?: EmbeddingConfig;
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
