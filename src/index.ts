export { BookLibrary, initializeLibrary } from "./library.js";
export type { IndexReport, IndexOptions } from "./library.js";
export { loadConfig } from "./config.js";
export { createRerankProvider } from "./providers/rerank.js";
export type { SearchOptions, SearchResponse, SearchMode } from "./storage/search.js";
export type {
  AppConfig,
  ChunkOptions,
  EmbeddingConfig,
  RerankConfig,
  RerankProvider,
  RerankResult,
  StoredChunk,
  SearchResult,
} from "./types.js";
