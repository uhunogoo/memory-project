#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkFile } from "./chunk.js";
import { helpMessage } from "./help-message.js";
import { discoverBooks } from "./helpers/discoverBooks.js";
import { openDatabase } from "./db.js";

async function main(): Promise<void> {
  // Parameters
  const { values, positionals } = parseArgs( {
    allowPositionals: true,
    options: {
      "chunk-size": { type: "string" },
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
    if (positionals.length !== 1) {
      throw new Error("Expected: book-memory index");
    }

    // Create BD if not existed
    const database = openDatabase();

    // Chunking and books parse logic
    try {
      const books = await discoverBooks( booksDirectory );

      for (const book of books) {
        for (const filePath of book.files) {
          const chunksData = await chunkFile( filePath, {
            chunkSize: values["chunk-size"]
          } );

          console.log(JSON.stringify(
            chunksData, null, 2
          ) );
        }
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
