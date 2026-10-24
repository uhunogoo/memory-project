export const config = {
  chunking: {
    strategy: "fixed-size",
    chunkSize: 2000,
    chunkOverlap: 200,
  },

  llm: {
    model: process.env.LLM_MODEL,
    apiKey: process.env.LLM_API_KEY,
  },
} as const;
