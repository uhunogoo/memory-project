#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkFile } from "./chunk.js";
import { helpMessage } from "./help-message.js";
import { discoverBooks } from "./ingestion/discoverBooks.js";
import { openDatabase } from "./db/db.js";
import { cleanBookChunks, saveBook, type ParsedFile } from "./db/actions.js";

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

        // here db
        const changedChunks = database.db.transaction((tx) => {
          if (values.clean) {
            const deleted = cleanBookChunks(tx, book.directory);
            console.log(`${deleted} chunks was succesfully removed`)
          }

          return saveBook(tx, book, filesChunks);
        });

        console.log(`Indexed "${book.name}": ${changedChunks.length} chunks`)
      }
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
