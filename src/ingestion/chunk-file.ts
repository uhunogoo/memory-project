import { resolve } from "node:path";
import OfficeParser, { OfficeConverter, OfficeGenerator, type OfficeChunk, type OfficeContentNode } from "officeparser";

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
  const ast = await OfficeParser.parseOffice(source);
  const sectionLevel = 3;
  const sections: OfficeContentNode[][] = [];

  let section: OfficeContentNode[] = [];
  let hasContent = false;

  /**
   * Parse nodes split them by title (H1-H3):
   * - merge content between them;
   */
  for (const node of ast.content) {
    const startsSection =
      node.type === "heading" &&
      (node.metadata?.level ?? 1) <= sectionLevel;

    if (startsSection && hasContent) {
      sections.push(section);
      section = [];
      hasContent = false;
    }

    section.push(node);

    if (node.type !== "heading" && node.type !== "break") {
      hasContent = true;
    }
  }

  // Last section exist
  if (section.length > 0) sections.push(section);

  const chunks: OfficeChunk[] = [];
  const messages = [...ast.warnings];

  // Parse ast by officeparse
  for (const content of sections) {
    const result = await OfficeGenerator.generate(
      { ...ast, content },
      "chunks",
      {
        chunksConfig: {
          strategy: "fixed-size",
          chunkSize: 2000,
          chunkOverlap: 200,
        },
      },
    );

    chunks.push(...result.value);
    messages.push(...result.messages);
  }

  return { source, chunks, messages };
}
