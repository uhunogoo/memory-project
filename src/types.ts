export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
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
  contentHash: string;
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
