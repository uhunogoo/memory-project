import { Buffer } from "node:buffer";
import { and, asc, eq, sql } from "drizzle-orm";
import ollama from "ollama";
import { config } from "../../config.js";
import type { DatabaseConnection } from "../connection.js";
import { chunks, embeddings } from "../schema.js";

export async function vectorSearch(db: DatabaseConnection["db"], query: string, limit: number) {
  const { model, dimensions } = config.embedding;
  if (!model) throw new Error("Не задано EMBEDDING_MODEL");

  const response = await ollama.embed({
    model: model,
    input: query,
    dimensions,
    truncate: false,
  });

  const vector = response.embeddings[0];
  if (
    response.embeddings.length !== 1 ||
    !vector ||
    vector.length !== dimensions ||
    !vector.every(Number.isFinite) ||
    !vector.some((value) => value !== 0)
  ) {
    throw new Error("Некоректний ембединг запиту");
  }

  const queryBlob = Buffer.from(new Float32Array(vector).buffer);
  const distance = sql<number>`
    vec_distance_cosine(${embeddings.embedding}, ${queryBlob})
  `;

  return db
    .select({
      id: chunks.id,
      text: chunks.text,
      sourceFile: chunks.source_file,
    })
    .from(embeddings)
    .innerJoin(chunks, eq(chunks.id, embeddings.chunkId))
    .where(and(eq(embeddings.model, model), eq(embeddings.dimensions, dimensions)))
    .orderBy(asc(distance), asc(chunks.id))
    .limit(limit)
    .all();
}
