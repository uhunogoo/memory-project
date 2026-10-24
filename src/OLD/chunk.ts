import { resolve } from "node:path";
import { OfficeConverter } from "officeparser";
import type { DocumentStructureChunkingConfig, FixedSizeChunkingConfig } from "officeparser";

export type ChunkOptions = DocumentStructureChunkingConfig | FixedSizeChunkingConfig;

/** Coordinates belong to officeparser's extracted text, not the original file. */
export async function chunkFile(
  file: string,
  options: ChunkOptions = { strategy: "document-structure" },
) {
  const size = options.strategy === "fixed-size" ? options.chunkSize : options.maxChunkSize;

  if (size !== undefined && (!Number.isSafeInteger(size) || size < 1)) {
    throw new Error("Chunk size must be a positive safe integer.");
  }

  if (options.strategy === "fixed-size") {
    const overlap = options.chunkOverlap ?? Math.min(200, Math.floor((size ?? 1000) / 5));
    if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= (size ?? 1000)) {
      throw new Error("Overlap must be a non-negative integer smaller than chunk size.");
    }
    options = { ...options, chunkOverlap: overlap };
  }

  const source = resolve(file);
  const { value: chunks, messages } = await OfficeConverter.convert( source, "chunks", {
    generatorConfig: {
      chunksConfig: {
        includeMetadata: true,
        addStartIndex: true,
        ...options
      },
    },
  } );

  return { source, chunks, messages };
}
