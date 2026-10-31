#!/usr/bin/env node
import { parseArgs } from "node:util";

import { helpMessage } from "./help-message.js";

import { chunkFile } from "./ingestion/chunk-file.js";
import { embedChunks } from "./ingestion/embed-chunks.js";
import { discoverBooks } from "./ingestion/discover-books.js";

// DB
import { openDatabase } from "./db/connection.js";
import { cleanBookChunks, saveBook, type ParsedFile } from "./db/books.js";
import { findPendingEmbeddings } from "./db/pending-embeddings.js"
import { hybridSearch } from "./db/hybrid-search.js";
import { resolve } from "node:path";


async function main(): Promise<void> {
  // Parameters
  const { values, positionals } = parseArgs( {
    allowPositionals: true,
    options: {
      "chunk-size": { type: "string" },
      limit: { type: "string", default: "10" },
      clean: { type: "boolean" },
      help: { type: "boolean" },
    },
  } );

  // Print help message
  if (values.help) {
    helpMessage();
    return;
  }

  const [ command, booksDirectory ] = positionals;

  // Continue embedding for missing chunks
  if (command === "embed") {
    if (positionals.length !== 2 || !booksDirectory) {
      throw new Error(
        "Expected: book-memory embed BOOK_DIRECTORY",
      );
    }

    const database = openDatabase();

    try {
      const pendingChunks = findPendingEmbeddings(
        database.db,
        resolve(booksDirectory)
      );

      const embeddedCount = await embedChunks(
        database.db,
        pendingChunks,
      );

      console.log(`Created ${embeddedCount} embeddings`);
    } finally {
      database.close();
    }

    return;
  }

  // Index: scan directory, chunking and upsert to DB
  if (command === "index") {
    if (positionals.length > 2) {
      throw new Error(
        "Expected: book-memory index [BOOKS_DIRECTORY] [--chunk-size NUMBER]",
      );
    }

    // Create BD if not existed
    const database = openDatabase();

    // Chunking and books parse logic
    try {
      const books = await discoverBooks(booksDirectory);

      for (const book of books) {
        const filesChunks: ParsedFile[] = [];
        for (const filePath of book.files) {
          const chunksData = await chunkFile( filePath, {
            chunkSize: values["chunk-size"]
          } );

          filesChunks.push(chunksData);
        }

        // Save chunks to DB
        const changedChunks = database.db.transaction((tx) => {
          if (values.clean) {
            const deleted = cleanBookChunks(tx, book.directory);
            console.log(`${deleted} chunks was succesfully removed`)
          }

          return saveBook(tx, book, filesChunks);
        });

        // Save embeddings
        const embeddedCount = await embedChunks(database.db, changedChunks);

        // Result
        console.log(
          `Indexed "${book.name}": ${changedChunks.length} chunks, ` +
          `${embeddedCount} embeddings`,
        );
      }
    } finally {
      database.close();
    }

    return;
  }

  // Search
  if (command === "search") {
    const query = positionals[1]?.trim();

    if (positionals.length !== 2 || !query) {
      throw new Error(
        'Expected: book-memory search "QUERY" [--limit NUMBER]',
      );
    }

    const limit = Number(values.limit);
    const database = openDatabase();

    try {
      const results = await hybridSearch(database.db, query, limit);
      const output = JSON.stringify(results, null, 2);

      console.log(output);
    } finally {
      database.close();
    }

    return;
  }
}

// Error handler
main().catch( (error: unknown) => {
  const errrorMessage = error instanceof Error ? error.message : String(error);

  console.error( errrorMessage );
  process.exitCode = 1;
} );
