import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

export interface ScrapedPage {
  url: string;
  content: string;
}

// Shared HTTP agent with connection pooling (keep-alive)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const scraperClient: AxiosInstance = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; SupportBot/1.0)',
  },
  httpAgent,
  httpsAgent,
});

/**
 * Run tasks with bounded concurrency.
 * @param items - Items to process
 * @param fn - Async function to process each item
 * @param concurrency - Max parallel tasks (default 5)
 */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function fetchSitemapUrls(domain: string): Promise<string[]> {
  const baseUrl = domain.replace(/\/$/, '');
  const sitemapUrl = baseUrl + '/sitemap.xml';
  
  try {
    const response = await scraperClient.get(sitemapUrl);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    
    const result = parser.parse(response.data);
    const urls: string[] = [];

    // Check if it's a sitemap index (contains sitemap tags)
    if (result.sitemapindex && result.sitemapindex.sitemap) {
      const sitemapEntries = Array.isArray(result.sitemapindex.sitemap) 
        ? result.sitemapindex.sitemap 
        : [result.sitemapindex.sitemap];
      
      // Fetch sub-sitemaps in parallel (up to 5 concurrently)
      const subUrlArrays = await parallelMap(
        sitemapEntries.filter((e: any) => e.loc),
        (entry: any) => fetchUrlsFromSitemap(entry.loc),
        5,
      );
      for (const subUrls of subUrlArrays) {
        urls.push(...subUrls);
      }
    }
    // Regular sitemap with urlset
    else if (result.urlset && result.urlset.url) {
      const urlEntries = Array.isArray(result.urlset.url) ? result.urlset.url : [result.urlset.url];
      for (const entry of urlEntries) {
        if (entry.loc) {
          urls.push(entry.loc);
        }
      }
    }

    return urls;
  } catch (error) {
    console.error(`Error fetching sitemap from ${sitemapUrl}:`, error);
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl: string): Promise<string[]> {
  try {
    const response = await scraperClient.get(sitemapUrl);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    
    const result = parser.parse(response.data);
    const urls: string[] = [];

    if (result.urlset && result.urlset.url) {
      const urlEntries = Array.isArray(result.urlset.url) ? result.urlset.url : [result.urlset.url];
      for (const entry of urlEntries) {
        if (entry.loc) {
          urls.push(entry.loc);
        }
      }
    }

    return urls;
  } catch (error) {
    console.error(`Error fetching sub-sitemap from ${sitemapUrl}:`, error);
    return [];
  }
}

export async function scrapePage(url: string): Promise<ScrapedPage | null> {
  try {
    const response = await scraperClient.get(url);

    const $ = cheerio.load(response.data);
    
    // Remove unwanted elements
    $('script, style, nav, footer, header, aside, .ads, .advertisement, .cookie-banner, #cookie-banner, .popup, .modal').remove();
    
    // Get main content
    let content = '';
    
    // Try common content selectors
    const contentSelectors = [
      'main',
      'article',
      '.content',
      '.main-content',
      '#content',
      '#main',
      '.post-content',
      '.entry-content',
      'body',
    ];
    
    for (const selector of contentSelectors) {
      const element = $(selector).first();
      if (element.length > 0) {
        content = element.text();
        break;
      }
    }
    
    // Clean up whitespace
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim();
    
    if (content.length < 100) {
      return null;
    }

    return { url, content };
  } catch (error) {
    console.error(`Error scraping ${url}:`, error);
    return null;
  }
}

/**
 * Scrape multiple pages in parallel with bounded concurrency.
 * @param urls - URLs to scrape
 * @param concurrency - Max parallel requests (default 5)
 * @param delayMs - Delay between launching each request (default 100ms, respectful crawling)
 */
export async function scrapePagesParallel(
  urls: string[],
  concurrency: number = 5,
  delayMs: number = 100,
): Promise<ScrapedPage[]> {
  const scrapedPages: ScrapedPage[] = [];

  // Launch tasks with staggered starts to avoid burst
  async function scrapeWithDelay(url: string): Promise<void> {
    const page = await scrapePage(url);
    if (page) {
      scrapedPages.push(page);
    }
  }

  // Process in batches of `concurrency` with small delays between batches
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    await Promise.all(batch.map(url => scrapeWithDelay(url)));
    // Small delay between batches to be respectful
    if (i + concurrency < urls.length && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return scrapedPages;
}

export function chunkText(text: string, maxChunkSize: number = 1000): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim() + '.';
    
    if (currentChunk.length + trimmed.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk += ' ' + trimmed;
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}