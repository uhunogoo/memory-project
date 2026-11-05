import { resolve } from "node:path";
import {
  OfficeParser,
  OfficeGenerator,
  type OfficeContentNode,
  type OfficeChunk,
} from "officeparser";

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

  // Chunking
  const source = resolve( filePath );
  const ast = await OfficeParser.parseOffice(source);

  // Chunks grouping to nodes separated by headers
  const groups: OfficeContentNode[][] = [];
  let currentGroup: OfficeContentNode[] = [];

  for (const node of ast.content) {
    const isHeading =
      node.type === "heading" &&
      node.metadata?.level !== undefined &&
      node.metadata.level <= chunking.headingLevel;

    if (isHeading && currentGroup.length) {
      groups.push(currentGroup);
      currentGroup = [];
    }

    currentGroup.push(node);
  }

  if (currentGroup.length) groups.push(currentGroup);

  // Fixed-size chunking within each group
  const chunks: OfficeChunk[] = [];
  const messages = [ ...ast.warnings ];

  for (const [groupIndex, group] of groups.entries()) {
    const { value, messages: groupMessages } = await OfficeGenerator.generate(
      { ...ast, content: group },
      "chunks",
      {
        chunksConfig: {
          strategy: chunking.strategy,
          chunkSize: chunkSize,
          chunkOverlap: chunking.chunkOverlap,
          separators: ["\n\n", "\n", " ", ""],
          includeMetadata: true,
        },
      }
    );

    messages.push(...groupMessages);

    // Restore metadata
    for (const chunk of value) {
      chunks.push({
        ...chunk,
        metadata: {
          ...chunk.metadata,
          groupIndex,
        },
      });
    }
  }

  return { source, chunks, messages };
}
