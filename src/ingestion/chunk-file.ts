import { resolve } from "node:path";
import { OfficeConverter } from "officeparser";

// Defaults
import { config } from "../config.js";

// Types
type ChunkOptions = {
  chunkSize?: string | number;
  chunkOverlap?: number;
};

// Chunking logic
export async function chunkFile(
  filePath: string,
  options: ChunkOptions = {},
) {
  // Defaults from config
  const { chunking } = config;

  // Handle chunkSize error
  const chunkSize = Number( options.chunkSize ?? chunking.chunkSize );
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunk-size має бути додатним цілим числом.");
  }

  // Params
  const source = resolve( filePath );

  // Chunking
  const { value: chunks, messages } = await OfficeConverter.convert( source, "chunks", {
    generatorConfig: {
      chunksConfig: {
        strategy: chunking.strategy,
        splitBy: chunking.splitBy,

        maxChunkSize: chunkSize,
      },
    },
  } );

  return { source, chunks, messages };
}
