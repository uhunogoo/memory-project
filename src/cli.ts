#!/usr/bin/env node
// import { z } from "zod";
import { parseArgs } from "node:util";
import { chunkFile } from "./chunk.js";
import { help, helpMessage } from "./help-message.js";
import { discoverBooks } from "./helpers/discoverBooks.js";
import { config } from "./config.js";

// const commandSchema = z.enum([
//   "index",
//   "chunks",
// ]);

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

  const [ command, file ] = positionals;

  if (command === "index") {
    if (positionals.length !== 1) {
      throw new Error("Expected: book-memory index");
    }

    const books = await discoverBooks(config.booksDirectory);
    console.log(books);

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

    return;
  }

}

// Error handler
main().catch( (error: unknown) => {
  const errrorMessage = error instanceof Error ? error.message : String(error);

  console.error( errrorMessage );
  process.exitCode = 1;
} );
