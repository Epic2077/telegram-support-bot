import { fetchSitemapUrls, scrapePagesParallel, chunkText, ScrapedPage } from './scraper';
import { generateEmbeddings, getTenantEmbeddingClient } from './embeddings';
import { insertKnowledgeChunksBatched, deleteKnowledgeBase } from './supabase';

// Configurable limits
const MAX_PAGES = parseInt(process.env.SCRAPER_MAX_PAGES || '500', 10);
const SCRAPE_CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY || '5', 10);
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPER_DELAY_MS || '100', 10);

export async function ingestWebsite(
  tenantId: string,
  domain: string,
  tenant?: { ai_provider?: string | null; ai_api_key?: string | null; embedding_provider?: string | null; embedding_api_key?: string | null },
): Promise<{ success: boolean; pagesScraped: number; chunksCreated: number; error?: string }> {
  try {
    console.log(`Starting ingestion for tenant ${tenantId}, domain: ${domain}`);
    const startTime = Date.now();

    // Clear existing knowledge base
    await deleteKnowledgeBase(tenantId);
    
    // Fetch URLs from sitemap
    const urls = await fetchSitemapUrls(domain);
    console.log(`Found ${urls.length} URLs in sitemap`);
    
    if (urls.length === 0) {
      return { success: false, pagesScraped: 0, chunksCreated: 0, error: 'No URLs found in sitemap' };
    }
    
    // Limit pages to scrape (configurable, default 500)
    const pagesToScrape = urls.slice(0, MAX_PAGES);
    console.log(`Scraping ${pagesToScrape.length} pages (concurrency: ${SCRAPE_CONCURRENCY})`);

    // Parallel scraping with connection pooling
    const scrapedPages = await scrapePagesParallel(pagesToScrape, SCRAPE_CONCURRENCY, SCRAPE_DELAY_MS);
    
    console.log(`Successfully scraped ${scrapedPages.length} pages in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    
    if (scrapedPages.length === 0) {
      return { success: false, pagesScraped: 0, chunksCreated: 0, error: 'No content could be scraped' };
    }
    
    // Chunk all content
    const allChunks: { page_url: string; content: string }[] = [];
    for (const page of scrapedPages) {
      const chunks = chunkText(page.content);
      for (const chunk of chunks) {
        allChunks.push({ page_url: page.url, content: chunk });
      }
    }
    
    console.log(`Created ${allChunks.length} chunks`);
    
    // Generate embeddings using tenant-specific client if available
    const texts = allChunks.map(c => c.content);
    const embeddingClient = tenant ? getTenantEmbeddingClient(tenant) : undefined;
    const embeddings = await generateEmbeddings(texts, embeddingClient);
    
    console.log(`Generated ${embeddings.length} embeddings`);
    
    // Prepare records for insertion
    const records = allChunks.slice(0, embeddings.length).map((chunk, index) => ({
      page_url: chunk.page_url,
      content: chunk.content,
      embedding: embeddings[index],
    }));
    
    // Batched insert into database (500 rows per batch)
    const inserted = await insertKnowledgeChunksBatched(tenantId, records);
    
    if (!inserted) {
      return { success: false, pagesScraped: scrapedPages.length, chunksCreated: 0, error: 'Failed to insert chunks into database' };
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Ingestion complete: ${scrapedPages.length} pages, ${records.length} chunks in ${elapsed}s`);

    return { 
      success: true, 
      pagesScraped: scrapedPages.length, 
      chunksCreated: records.length 
    };
  } catch (error) {
    console.error('Error in ingestWebsite:', error);
    return { 
      success: false, 
      pagesScraped: 0, 
      chunksCreated: 0, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}