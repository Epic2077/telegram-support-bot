import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.SYSTEM_OPENAI_KEY!,
});

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  
  // Process in batches to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const promises = batch.map(text => generateEmbedding(text));
    const results = await Promise.all(promises);
    
    for (const embedding of results) {
      if (embedding) {
        embeddings.push(embedding);
      }
    }
    
    // Small delay between batches
    if (i + batchSize < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return embeddings;
}