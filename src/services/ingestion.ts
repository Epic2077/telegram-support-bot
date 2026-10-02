import { fetchSitemapUrls, scrapePage, chunkText, ScrapedPage } from './scraper';
import { generateEmbeddings } from './embeddings';
import { insertKnowledgeChunks, deleteKnowledgeBase } from './supabase';

export async function ingestWebsite(tenantId: string, domain: string): Promise<{ success: boolean; pagesScraped: number; chunksCreated: number; error?: string }> {
  try {
    console.log(`Starting ingestion for tenant ${tenantId}, domain: ${domain}`);
    
    // Clear existing knowledge base
    await deleteKnowledgeBase(tenantId);
    
    // Fetch URLs from sitemap
    const urls = await fetchSitemapUrls(domain);
    console.log(`Found ${urls.length} URLs in sitemap`);
    
    if (urls.length === 0) {
      return { success: false, pagesScraped: 0, chunksCreated: 0, error: 'No URLs found in sitemap' };
    }
    
    // Scrape pages (limit to first 50 to avoid timeout)
    const pagesToScrape = urls.slice(0, 50);
    const scrapedPages: ScrapedPage[] = [];
    
    for (const url of pagesToScrape) {
      const page = await scrapePage(url);
      if (page) {
        scrapedPages.push(page);
      }
      // Small delay to be respectful
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log(`Successfully scraped ${scrapedPages.length} pages`);
    
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
    
    // Generate embeddings
    const texts = allChunks.map(c => c.content);
    const embeddings = await generateEmbeddings(texts);
    
    console.log(`Generated ${embeddings.length} embeddings`);
    
    // Prepare records for insertion
    const records = allChunks.slice(0, embeddings.length).map((chunk, index) => ({
      page_url: chunk.page_url,
      content: chunk.content,
      embedding: embeddings[index],
    }));
    
    // Insert into database
    const inserted = await insertKnowledgeChunks(tenantId, records);
    
    if (!inserted) {
      return { success: false, pagesScraped: scrapedPages.length, chunksCreated: 0, error: 'Failed to insert chunks into database' };
    }
    
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