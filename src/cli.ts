#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseMarkdown } from "./ingestion/markdown.js";

const help = `book-memory chunk FILE.md [options]

Split a Markdown file into chunks and print JSON to stdout.

Options:
  --target-tokens NUMBER   Approximate chunk size (default: 800)
  --overlap-tokens NUMBER  Maximum overlap (default: min(100, target / 8))
  --help                  Show this help

Sizes are estimated as UTF-8 bytes / 3, not model tokenizer counts.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "target-tokens": { type: "string" },
      "overlap-tokens": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const [command, file] = positionals;
  if (command !== "chunk" || !file || positionals.length !== 2) {
    throw new Error(`Expected: book-memory chunk FILE.md\n\n${help}`);
  }
  if (extname(file).toLowerCase() !== ".md") {
    throw new Error("Only Markdown (.md) files are supported.");
  }
  const targetTokens = Number(values["target-tokens"] ?? 800);
  const overlapTokens = Number(
    values["overlap-tokens"] ?? Math.min(100, Math.floor(targetTokens / 8)),
  );
  const path = resolve(file);
  const markdown = await readFile(path, "utf8");
  const document = parseMarkdown(path, markdown, basename(path), { targetTokens, overlapTokens });
  console.log(JSON.stringify(document, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
