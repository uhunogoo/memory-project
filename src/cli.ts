#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkFile } from "./ingestion/chunk-file.js";
import { helpMessage } from "./help-message.js";
import { discoverBooks } from "./ingestion/discover-books.js";
import { openDatabase } from "./db/connection.js";
import { cleanBookChunks, saveBook, type ParsedFile } from "./db/books.js";
import { embedChunks } from "./ingestion/embed-chunks.js";

async function main(): Promise<void> {
  // Parameters
  const { values, positionals } = parseArgs( {
    allowPositionals: true,
    options: {
      "chunk-size": { type: "string" },
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

  }
}

// Error handler
main().catch( (error: unknown) => {
  const errrorMessage = error instanceof Error ? error.message : String(error);

  console.error( errrorMessage );
  process.exitCode = 1;
} );
