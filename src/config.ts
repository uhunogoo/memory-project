import 'dotenv/config';

export const config = {
  booksDirectory: "books",
  chunking: {
    headingLevel: 3,
    strategy: "fixed-size",
    chunkSize: 2000,
    chunkOverlap: 150,
  },

  embedding: {
    dimensions: 768,
    model: process.env.EMBEDDING_MODEL,
    apiKey: process.env.EMBEDDING_API_KEY,
  },
} as const;
