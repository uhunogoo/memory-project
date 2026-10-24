#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkFile } from "./chunk.js";
import { help, helpMessage } from "./help-message.js";

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

  const [command, file] = positionals;
  if (command !== "chunk" || !file || positionals.length !== 2) {
    throw new Error(`Expected: book-memory chunk FILE\n\n${ help }`);
  }

  const chunksData = await chunkFile(file, {
    chunkSize: values["chunk-size"]
  });

  console.log(JSON.stringify(
    chunksData, null, 2
  ) );
}

// Error handler
main().catch( (error: unknown) => {
  const errrorMessage = error instanceof Error ? error.message : String(error);

  console.error( errrorMessage );
  process.exitCode = 1;
} );
