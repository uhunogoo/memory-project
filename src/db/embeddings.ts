import ollama from 'ollama';
import { sql } from "drizzle-orm";
import { config } from '../config.js';
import { saveRows } from "./save-rows.js";
import { embeddings } from '../schemas/schema.js';

// Types
import type { DatabaseConnection } from './db.js';
import type { ChangedChunk } from './actions.js';

// Const
type Db = DatabaseConnection["db"];
type EmbeddingRow = typeof embeddings.$inferInsert;

const BATCH_SIZE = 6;

export async function embedChunks(db: Db, chunks: ChangedChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  const { model, dimensions } = config.embedding;

  if (!model || !dimensions) {
    throw new Error("Не задано EMBEDDING_MODEL");
  }

  let savedCount = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const currentBatch = chunks.slice(i, i + BATCH_SIZE);
    const currentTextBatch = currentBatch.map(chunk => chunk.text);

    const response = await ollama.embed({
      model: model,
      input: currentTextBatch,
      dimensions: dimensions,
      truncate: false
    });

    if (response.embeddings.length !== currentBatch.length) {
      throw new Error(
        "Кількість embeddings не відповідає кількості чанків",
      );
    }

    const rows: EmbeddingRow[] = currentBatch.map((chunk, index) => {
      const vector = response.embeddings[index];

      return {
        chunkId: chunk.id,
        model: model,
        dimensions: dimensions,
        embedding: Buffer.from(new Float32Array(vector).buffer),
      };
    });

    savedCount += saveRows(db, embeddings, rows, {
      target: [
        embeddings.chunkId,
        embeddings.model,
        embeddings.dimensions,
      ],
      set: {
        embedding: sql`excluded.embedding`,
      },
    }).length;
  }

  return savedCount;
}
