/**
 * Voyage AI client for code embeddings and reranking.
 * Pure fetch() — no SDK dependency.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1";
const EMBEDDING_MODEL = "voyage-code-3";
const RERANK_MODEL = "rerank-2.5";
const EMBEDDING_DIMENSION = 1024;
const MAX_BATCH_ITEMS = 1000;
const MAX_BATCH_TOKENS = 120_000;

// Rough estimate: 1 token ≈ 4 chars for code
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Embed code chunks or a search query.
 * Automatically splits into multiple requests if batch exceeds limits.
 */
export async function embedCode(
  texts: string[],
  inputType: "query" | "document",
  apiKey: string
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Split into batches respecting token and item limits
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (
      currentBatch.length >= MAX_BATCH_ITEMS ||
      (currentBatch.length > 0 && currentTokens + tokens > MAX_BATCH_TOKENS)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(text);
    currentTokens += tokens;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const allEmbeddings: number[][] = [];

  for (const batch of batches) {
    const res = await fetch(`${VOYAGE_API_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: batch,
        model: EMBEDDING_MODEL,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSION,
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Voyage embeddings failed (${res.status}): ${errorBody}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

/**
 * Rerank documents by relevance to a query.
 * Returns results sorted by descending relevance_score.
 */
export async function rerankCode(
  query: string,
  documents: string[],
  topK: number,
  apiKey: string
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];

  const res = await fetch(`${VOYAGE_API_URL}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: RERANK_MODEL,
      top_k: topK,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Voyage rerank failed (${res.status}): ${errorBody}`);
  }

  const data = (await res.json()) as {
    data: Array<{ index: number; relevance_score: number }>;
  };

  return data.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}
