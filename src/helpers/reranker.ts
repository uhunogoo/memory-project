import ollama from "ollama";

export async function reranker( query: string, chunks: [] ) {
  if (chunks.length === 0) return;
  // console.log('ch: ', chunks);

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
  const response = chunks.map((chunk, i) => ({
    chunk,
    score: answers[`chunk_${i}`].score,
  })).sort((a, b) => b.score - a.score);
  console.log( response[0] )

  return response;
}
