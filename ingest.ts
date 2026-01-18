#!/usr/bin/env bun
/**
 * Idea Tinder - News Ingestion Script
 * 
 * Aggregates tech news from RSS feeds and changelogs.
 * Run daily via cron: 0 8 * * * /home/eli/.bun/bin/bun /home/eli/idea-tinder/ingest.ts
 * 
 * Target: ~6 quality items per day
 */

import { Database } from "bun:sqlite";

const db = new Database("/home/eli/idea-tinder/ideas.db");

// =============================================================================
// RSS FEEDS TO MONITOR
// =============================================================================
interface FeedConfig {
  url: string;
  source: string;
  category: string;
  maxItems: number;  // Max items to take from this feed per run
}

const FEEDS: FeedConfig[] = [
  // AI / ML - Note: Anthropic doesn't have RSS, using HuggingFace & Ollama instead
  { url: "https://openai.com/blog/rss.xml", source: "OpenAI", category: "ai", maxItems: 2 },
  { url: "https://huggingface.co/blog/feed.xml", source: "Hugging Face", category: "ai", maxItems: 2 },
  
  // Dev Tools
  { url: "https://bun.sh/rss.xml", source: "Bun", category: "dev-tools", maxItems: 2 },
  { url: "https://blog.rust-lang.org/feed.xml", source: "Rust Blog", category: "dev-tools", maxItems: 1 },
  { url: "https://github.blog/changelog/feed/", source: "GitHub Changelog", category: "dev-tools", maxItems: 2 },
  
  // Cloud / Infra
  { url: "https://vercel.com/atom", source: "Vercel", category: "cloud", maxItems: 2 },
  { url: "https://blog.cloudflare.com/rss/", source: "Cloudflare", category: "cloud", maxItems: 2 },
  
  // Web
  { url: "https://developer.chrome.com/blog/feed.xml", source: "Chrome DevRel", category: "web", maxItems: 1 },
];

// =============================================================================
// RSS PARSER (Simple implementation without external deps)
// =============================================================================
interface RSSItem {
  title: string;
  link: string;
  description: string;
  pubDate?: Date;
}

async function fetchRSS(url: string): Promise<RSSItem[]> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "IdeaTinder/1.0 (news aggregator)" }
    });
    
    if (!response.ok) {
      console.log(`  ⚠ HTTP ${response.status} for ${url}`);
      return [];
    }
    
    const xml = await response.text();
    const items: RSSItem[] = [];
    
    // Parse RSS (handles both RSS 2.0 and Atom)
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi);
    
    for (const match of itemMatches) {
      const itemXml = match[1] || match[2];
      
      // Extract title
      const titleMatch = itemXml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
      
      // Extract link
      const linkMatch = itemXml.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>|<link[^>]*href="([^"]+)"/i);
      const link = linkMatch ? (linkMatch[1] || linkMatch[2] || "").trim() : "";
      
      // Extract description/summary/content
      const descMatch = itemXml.match(/<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i);
      let description = descMatch ? decodeEntities(descMatch[1].trim()) : "";
      
      // Strip HTML tags for cleaner summary
      description = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      
      // Truncate description
      if (description.length > 300) {
        description = description.substring(0, 297) + "...";
      }
      
      // Extract date
      const dateMatch = itemXml.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : undefined;
      
      if (title && link) {
        items.push({ title, link, description, pubDate });
      }
    }
    
    return items;
  } catch (error) {
    console.log(`  ✗ Error fetching ${url}: ${error}`);
    return [];
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================
function ideaExists(url: string): boolean {
  const result = db.query("SELECT id FROM ideas WHERE url = ?").get(url);
  return !!result;
}

function inferContentType(url: string, source: string): string {
  // Infer content type from URL patterns
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'video';
  if (url.includes('arxiv.org') || url.includes('/paper')) return 'paper';
  if (source.toLowerCase().includes('changelog') || url.includes('/changelog')) return 'changelog';
  if (url.includes('/releases/') || url.includes('/release/')) return 'release';
  if (url.includes('vimeo.com') || url.includes('/watch')) return 'video';
  return 'article';
}

function insertIdea(idea: { title: string; source: string; summary: string; url: string; category: string; sourceFeed: string }): boolean {
  try {
    const contentType = inferContentType(idea.url, idea.source);
    db.query(`
      INSERT INTO ideas (title, source, summary, url, category, source_feed, content_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(idea.title, idea.source, idea.summary, idea.url, idea.category, idea.sourceFeed, contentType);
    return true;
  } catch (error) {
    console.log(`  ✗ Error inserting: ${error}`);
    return false;
  }
}

// =============================================================================
// MAIN INGESTION
// =============================================================================
async function ingest() {
  console.log("🔄 Starting news ingestion...\n");
  
  let totalNew = 0;
  let totalSkipped = 0;
  
  for (const feed of FEEDS) {
    console.log(`📰 ${feed.source} (${feed.url})`);
    
    const items = await fetchRSS(feed.url);
    
    if (items.length === 0) {
      console.log("   No items found\n");
      continue;
    }
    
    // Sort by date (newest first) and take max items
    const sortedItems = items
      .filter(item => item.title && item.link)
      .sort((a, b) => {
        if (!a.pubDate || !b.pubDate) return 0;
        return b.pubDate.getTime() - a.pubDate.getTime();
      })
      .slice(0, feed.maxItems);
    
    let added = 0;
    let skipped = 0;
    
    for (const item of sortedItems) {
      if (ideaExists(item.link)) {
        skipped++;
        totalSkipped++;
        continue;
      }
      
      const success = insertIdea({
        title: item.title,
        source: feed.source,
        summary: item.description || `New update from ${feed.source}. Click to read more.`,
        url: item.link,
        category: feed.category,
        sourceFeed: feed.url,
      });
      
      if (success) {
        added++;
        totalNew++;
        console.log(`   ✓ ${item.title.substring(0, 60)}...`);
      }
    }
    
    console.log(`   Added: ${added}, Skipped (existing): ${skipped}\n`);
  }
  
  console.log("━".repeat(50));
  console.log(`✅ Ingestion complete!`);
  console.log(`   New items: ${totalNew}`);
  console.log(`   Skipped: ${totalSkipped}`);
  
  const total = db.query("SELECT COUNT(*) as count FROM ideas").get() as { count: number };
  console.log(`   Total in database: ${total.count}`);
}

// Run
ingest().catch(console.error);




