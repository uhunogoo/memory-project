import ollama from "ollama";

export async function reranker<T extends { text: string }>(
  query: string, chunks: T[]
): Promise<{ chunk: T; score: number }[]> {
  if (chunks.length === 0) return [];

  // Format chunks
  const questions = chunks.map((chunk, i) => [
    `chunk_${i}`,
    {
      type: "noul",
      instructions: {
        passage: chunk.text,
        question: "Does this passage contain information that helps answer the query?"
      },
      criteria: {
        true: "The passage contains a direct answer or useful supporting evidence.",
        false: "The passage only shares the topic or keywords without helping answer the query."
      }
    }
  ]);
  const formattedQuestions = Object.fromEntries(questions);

  // Calculate score for chunks
  const { answers } = await ollama.systemone({
    model: "d1:latest",
    state: { query: query },
    questions: formattedQuestions
  });

  // Format chunks score
  const response = chunks.map((chunk, i) => {
    const answer = answers[`chunk_${i}`];

    if (!answer || answer.type !== "noul") {
      throw new Error(`Некоректна відповідь reranker для chunk_${i}`);
    }

    return { chunk, score: answer.noul };
  }).sort((a, b) => b.score - a.score);

  return response;
}
