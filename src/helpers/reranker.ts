import ollama from "ollama";

export async function reranker( query: string, chunks: [] ) {
  if (chunks.length === 0) return;
  // console.log('ch: ', chunks);

  // Format chunks
  const questions = chunks.map((chunk, i) => [
    `chunk_${i}`,
    {
      type: "score",
      instructions: chunk.text,
      criteria: [
        "Irrelevant: does not help answer the query",
        "Partially relevant: useful context but no direct answer",
        "Directly relevant: contains information answering the query",
      ],
    }
  ]);
  const formattedQuestions = Object.fromEntries(questions);

  // console.log('fm: ',formattedQuestions)

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
