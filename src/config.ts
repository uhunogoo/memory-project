import 'dotenv/config';

export const config = {
  booksDirectory: "books",
  chunking: {
    strategy: "document-structure",
    splitBy: "heading",
    chunkSize: 2000,
    chunkOverlap: 200,
  },

  embedding: {
    dimensions: 768,
    model: process.env.EMBEDDING_MODEL,
    apiKey: process.env.EMBEDDING_API_KEY,
  },
} as const;
