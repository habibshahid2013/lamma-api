/**
 * Voyage AI query embedding client.
 *
 * Uses input_type: 'query' for asymmetric semantic search —
 * queries are embedded differently from documents for better retrieval.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_TIMEOUT_MS = 5_000;

export async function embedQuery(text: string): Promise<number[]> {
  const model = (process.env.VOYAGE_MODEL || 'voyage-3').trim();
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) throw new Error('VOYAGE_API_KEY environment variable is required');

  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [text], model, input_type: 'query' }),
    signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Voyage AI API error (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return result.data[0].embedding;
}
