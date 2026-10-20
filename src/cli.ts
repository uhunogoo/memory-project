#!/usr/bin/env node
import { parseCliArguments } from "./cli-args.js";
import { loadConfig } from "./config.js";
import { BookLibrary, initializeLibrary } from "./library.js";

const help = `book-memory — Markdown books, chunks and hybrid retrieval

Usage: vp run memory <command> [arguments] [options]

  init                         Create books/ and initialize both databases
  index [--no-embed]            Scan all books and synchronize the index
  embed                        Resume missing/failed embeddings without rescanning
  status                       Show counts, active profile and last indexing run
  books                        List indexed books and their IDs
  sections [--book ID]          List sections and source positions
  chunks [--book ID]            Inspect original chunks and embedding inputs
  get CHUNK_ID                 Read one chunk with exact source coordinates
  document DOCUMENT_ID         Read the indexed original Markdown file
  search "query"               Search; default mode is hybrid

Options:
  --config PATH                Configuration file (default: memory.config.json)
  --mode lexical|vector|hybrid  Search mode
  --limit N                    Maximum results, 1–100 (default: 10)
  --book ID                    Restrict to a book ID from the books command
  --json                       Machine-readable JSON output
  --no-embed                   Update text and queue embeddings for later
  --help                       Show help

Without an embedding configuration, indexing and lexical search work offline.
Only embedding requests use your configured provider. No answers are generated.
`;

async function main(): Promise<void> {
  const parsed = parseCliArguments(process.argv.slice(2));
  if (!parsed) {
    console.log(help);
    return;
  }
  const { command, args, values } = parsed;
  const config = await loadConfig(values.config);
  if (command === "init") {
    await initializeLibrary(config);
    console.log(
      JSON.stringify(
        { booksDir: config.booksDir, dataDir: config.dataDir, initialized: true },
        null,
        2,
      ),
    );
    return;
  }
  const library = new BookLibrary(config);
  try {
    let result: unknown;
    switch (command) {
      case "index": {
        const report = await library.index({ embed: !values["no-embed"] });
        if (report.failed) process.exitCode = 2;
        result = report;
        break;
      }
      case "embed": {
        const report = await library.embed();
        if (report.failed) process.exitCode = 2;
        result = report;
        break;
      }
      case "status":
        result = library.status();
        break;
      case "books":
        result = library.content.listBooks();
        break;
      case "sections":
        result = library.content.listSections(values.book);
        break;
      case "chunks":
        result = library.content.listChunks(values.book);
        break;
      case "get":
        result = library.content.getChunk(args[0]!);
        if (!result) throw new Error("Chunk not found.");
        break;
      case "document":
        result = library.content.getDocument(args[0]!);
        if (!result) throw new Error("Document not found.");
        break;
      case "search": {
        const response = await library.search(args[0]!, {
          mode: values.mode,
          limit: values.limit === undefined ? undefined : Number(values.limit),
          bookId: values.book,
        });
        if (values.json) {
          result = response;
          break;
        }
        for (const warning of response.warnings) console.error(`Warning: ${warning}`);
        if (!response.results.length) console.log("No matches.");
        for (const [index, item] of response.results.entries()) {
          console.log(
            `\n${index + 1}. ${item.bookTitle} / ${item.headingPath.join(" / ") || "(preamble)"}`,
          );
          console.log(
            `${item.relativePath}#${item.anchor} · lines ${item.startLine}–${item.endLine} · ${item.matches.join("+")} · RRF ${item.score.toFixed(5)}`,
          );
          console.log(`chunk: ${item.id}\ndocument: ${item.documentId}\n\n${item.markdown}`);
        }
        return;
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    library.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
});
