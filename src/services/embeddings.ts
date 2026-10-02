import 'dotenv/config';
import OpenAI from 'openai';

// --- OpenAI Client Cache ---
// Key: `${apiKey}|${baseURL}`, Value: OpenAI instance
const clientCache = new Map<string, OpenAI>();

/**
 * Get or create a cached OpenAI client instance.
 * Supports custom base URLs for Liara, DeepSeek, etc.
 */
export function getOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  const cacheKey = `${apiKey}|${baseURL || 'default'}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
    clientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Get the system embedding client (uses SYSTEM_OPENAI_KEY).
 */
export function getSystemEmbeddingClient(): OpenAI {
  return getOpenAIClient(process.env.SYSTEM_OPENAI_KEY!);
}

/**
 * Get a tenant-specific embedding client if configured, 
 * otherwise falls back to system embedding client.
 */
export function getTenantEmbeddingClient(tenant: {
  ai_provider?: string | null;
  ai_api_key?: string | null;
  embedding_provider?: string | null;
  embedding_api_key?: string | null;
}): OpenAI {
  // If tenant has dedicated embedding key, use it
  if (tenant.embedding_api_key) {
    let baseURL: string | undefined;
    const provider = tenant.embedding_provider || tenant.ai_provider;
    if (provider === 'deepseek') baseURL = 'https://api.deepseek.com/v1';
    if (provider === 'gapgpt') baseURL = 'https://api.gapgpt.app/v1';
    if (provider === 'liara') baseURL = process.env.AI_LIARA_BASE_URL || 'https://ai.liara.ir/api/6abe8dfc7ce6d9a9e0475844/v1';
    return getOpenAIClient(tenant.embedding_api_key, baseURL);
  }
  // Fallback to system key
  return getSystemEmbeddingClient();
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = 100; // OpenAI supports up to 2048 inputs per call; 100 is safe and efficient

/**
 * Generate a single embedding (convenience wrapper).
 */
export async function generateEmbedding(text: string, client?: OpenAI): Promise<number[] | null> {
  try {
    const c = client || getSystemEmbeddingClient();
    const response = await c.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

/**
 * Generate embeddings in batches of up to 100 texts per API call.
 * Much faster than 1-by-1: reduces HTTP overhead from N calls to ceil(N/100).
 * 
 * @param texts - Array of text strings to embed
 * @param client - Optional OpenAI client (defaults to system key)
 * @returns Array of embedding vectors (same order as input; failed embeddings are skipped)
 */
export async function generateEmbeddings(texts: string[], client?: OpenAI): Promise<number[][]> {
  const c = client || getSystemEmbeddingClient();
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    try {
      const response = await c.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });

      // Sort by index to maintain order (API may return out of order)
      const sorted = response.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allEmbeddings.push(item.embedding);
      }
    } catch (error) {
      console.error(`Error generating embeddings batch ${i}-${i + batch.length}:`, error);
      // On batch failure, fall back to individual calls for this batch
      for (const text of batch) {
        const emb = await generateEmbedding(text, c);
        if (emb) {
          allEmbeddings.push(emb);
        }
      }
    }

    // Rate limit pause between batches (small delay)
    if (i + EMBEDDING_BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return allEmbeddings;
}