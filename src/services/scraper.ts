import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

export interface ScrapedPage {
  url: string;
  content: string;
}

export async function fetchSitemapUrls(domain: string): Promise<string[]> {
  const baseUrl = domain.replace(/\/$/, '');
  const sitemapUrl = baseUrl + '/sitemap.xml';
  
  try {
    const response = await axios.get(sitemapUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SupportBot/1.0)',
      },
    });

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
      
      for (const entry of sitemapEntries) {
        if (entry.loc) {
          // Fetch each individual sitemap
          const subUrls = await fetchUrlsFromSitemap(entry.loc);
          urls.push(...subUrls);
        }
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
    const response = await axios.get(sitemapUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SupportBot/1.0)',
      },
    });

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
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SupportBot/1.0)',
      },
    });

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