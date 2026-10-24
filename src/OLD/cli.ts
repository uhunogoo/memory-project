#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkFile } from "./chunk.js";
import type { ChunkOptions } from "./chunk.js";

const help = `book-memory chunk FILE [options]

Parse a document with officeparser and print JSON chunks to stdout.
Supports Markdown, PDF, DOCX, PPTX, XLSX and other officeparser formats.

Options:
  --strategy NAME        document-structure (default) or fixed-size
  --chunk-size NUMBER    Size in UTF-16 code units (default: 1000)
  --overlap NUMBER       fixed-size only (default: min(200, size / 5))
  --split-by NAME        Structure only: paragraph (default), heading, page, slide, sheet
  --table-split NAME     Structure only: row (default) or flatten
  --help                Show this help

Indices refer to extracted text, not original file offsets. OCR is disabled.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      strategy: { type: "string" },
      "chunk-size": { type: "string" },
      overlap: { type: "string" },
      "split-by": { type: "string" },
      "table-split": { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(help);
    return;
  }

  const [command, file] = positionals;
  if (command !== "chunk" || !file || positionals.length !== 2) {
    throw new Error(`Expected: book-memory chunk FILE\n\n${help}`);
  }

  const size = Number(values["chunk-size"] ?? 1000);
  const strategy = values.strategy ?? "document-structure";
  let options: ChunkOptions;
  if (strategy === "fixed-size") {
    if (values["split-by"] !== undefined || values["table-split"] !== undefined) {
      throw new Error("--split-by and --table-split require document-structure.");
    }

    options = {
      strategy,
      chunkSize: size,
      chunkOverlap: Number(values.overlap ?? Math.min(200, Math.floor(size / 5))),
    };
  } else if (strategy === "document-structure") {
    if (values.overlap !== undefined) throw new Error("--overlap requires fixed-size.");

    const splitBy = values["split-by"] ?? "paragraph";
    if (
      splitBy !== "paragraph" &&
      splitBy !== "heading" &&
      splitBy !== "page" &&
      splitBy !== "slide" &&
      splitBy !== "sheet"
    ) {
      throw new Error("Invalid --split-by. Use paragraph, heading, page, slide or sheet.");
    }

    const tableSplitStrategy = values["table-split"] ?? "row";
    if (tableSplitStrategy !== "row" && tableSplitStrategy !== "flatten") {
      throw new Error("Invalid --table-split. Use row or flatten.");
    }

    options = { strategy, maxChunkSize: size, splitBy, tableSplitStrategy };
  } else {
    throw new Error("Invalid --strategy. Use document-structure or fixed-size.");
  }

  console.log( JSON.stringify(
    await chunkFile(file, options), null, 2
  ) );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
