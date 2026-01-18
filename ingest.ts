#!/usr/bin/env bun
/**
 * Idea Tinder - News Ingestion Script
 * 
 * Fetches RSS feeds from all users, deduplicates, and distributes items.
 * Run daily via cron: 0 14 * * * (9am Eastern)
 * 
 * Flow:
 * 1. Collect all unique enabled feed URLs from user_feeds
 * 2. Fetch each feed once
 * 3. Insert new items into global ideas table
 * 4. Add items to user_pending for each user with that feed
 * 5. Clean up old unswiped items (7+ days)
 */

import { Database } from "bun:sqlite";

const db = new Database("/home/eli/idea-tinder/ideas.db");

// =============================================================================
// DATABASE SETUP
// =============================================================================

// Create user_pending table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS user_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    idea_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE,
    UNIQUE(user_id, idea_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_pending_user ON user_pending(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_pending_added ON user_pending(added_at);
`);

// =============================================================================
// DEFAULT FEEDS (seeded for new users)
// =============================================================================
export const DEFAULT_FEEDS = [
  { url: "https://hnrss.org/frontpage", name: "Hacker News", category: "tech" },
  { url: "https://www.anthropic.com/rss.xml", name: "Anthropic", category: "ai" },
  { url: "https://openai.com/blog/rss.xml", name: "OpenAI Blog", category: "ai" },
  { url: "https://blog.google/technology/ai/rss/", name: "Google AI Blog", category: "ai" },
  { url: "https://simonwillison.net/atom/everything/", name: "Simon Willison", category: "ai" },
  { url: "https://www.latent.space/feed", name: "Latent Space", category: "ai" },
  { url: "https://buttondown.com/ainews/rss", name: "AI News", category: "ai" },
  { url: "https://blog.cloudflare.com/rss/", name: "Cloudflare Blog", category: "cloud" },
  { url: "https://medium.com/feed/flutter", name: "Flutter Medium", category: "dev-tools" },
  { url: "https://medium.com/feed/dartlang", name: "Dart Medium", category: "dev-tools" },
  { url: "https://github.blog/feed/", name: "GitHub Blog", category: "dev-tools" },
  { url: "https://vercel.com/atom", name: "Vercel Blog", category: "dev-tools" },
];

// =============================================================================
// RSS PARSER
// =============================================================================
interface RSSItem {
  title: string;
  link: string;
  description: string;
  pubDate?: Date;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function fetchRSS(url: string): Promise<RSSItem[]> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "IdeaTinder/1.0 (news aggregator)" },
      signal: AbortSignal.timeout(15000), // 15 second timeout
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
      
      // Strip HTML tags
      description = description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      
      // Handle HN-style descriptions (Article URL: ... Comments URL: ... Points: N # Comments: M)
      const hnMatch = description.match(/Points:\s*(\d+)\s*#\s*Comments:\s*(\d+)/i);
      if (hnMatch || description.startsWith("Article URL:")) {
        const points = hnMatch ? hnMatch[1] : "?";
        const comments = hnMatch ? hnMatch[2] : "?";
        description = `${points} points · ${comments} comments on Hacker News`;
      }
      
      // Truncate
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

// =============================================================================
// HELPERS
// =============================================================================

function ideaExistsByUrl(url: string): number | null {
  const result = db.query("SELECT id FROM ideas WHERE url = ?").get(url) as { id: number } | null;
  return result?.id || null;
}

function inferContentType(url: string, source: string): string {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'video';
  if (url.includes('arxiv.org') || url.includes('/paper')) return 'paper';
  if (source.toLowerCase().includes('changelog') || url.includes('/changelog')) return 'changelog';
  if (url.includes('/releases/') || url.includes('/release/')) return 'release';
  return 'article';
}

function insertIdea(idea: { title: string; source: string; summary: string; url: string; category: string; sourceFeed: string; publishedAt?: Date }): number | null {
  try {
    const contentType = inferContentType(idea.url, idea.source);
    const publishedAt = idea.publishedAt ? idea.publishedAt.toISOString() : null;
    const stmt = db.query(`
      INSERT INTO ideas (title, source, summary, url, category, source_feed, content_type, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(idea.title, idea.source, idea.summary, idea.url, idea.category, idea.sourceFeed, contentType, publishedAt);
    
    // Get the inserted ID
    const result = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
    return result.id;
  } catch (error) {
    console.log(`  ✗ Error inserting: ${error}`);
    return null;
  }
}

function addToUserPending(userId: number, ideaId: number): boolean {
  try {
    db.query("INSERT OR IGNORE INTO user_pending (user_id, idea_id) VALUES (?, ?)").run(userId, ideaId);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// MAIN INGESTION
// =============================================================================

async function ingest() {
  console.log("🔄 Starting news ingestion...\n");
  console.log(`📅 ${new Date().toISOString()}\n`);
  
  // Step 1: Get all unique enabled feeds with their users
  const feedsWithUsers = db.query(`
    SELECT url, name, category, GROUP_CONCAT(user_id) as user_ids
    FROM user_feeds 
    WHERE enabled = 1
    GROUP BY url
  `).all() as { url: string; name: string; category: string; user_ids: string }[];
  
  console.log(`📡 Found ${feedsWithUsers.length} unique feeds across all users\n`);
  
  if (feedsWithUsers.length === 0) {
    console.log("No feeds to process. Exiting.");
    return;
  }
  
  let totalNew = 0;
  let totalSkipped = 0;
  
  // Step 2: Fetch each feed once, distribute to users
  for (const feed of feedsWithUsers) {
    const userIds = feed.user_ids.split(",").map(id => parseInt(id));
    console.log(`📰 ${feed.name} (${userIds.length} users)`);
    
    const items = await fetchRSS(feed.url);
    
    if (items.length === 0) {
      console.log("   No items found\n");
      // Update last_fetched anyway
      db.query("UPDATE user_feeds SET last_fetched = CURRENT_TIMESTAMP WHERE url = ?").run(feed.url);
      continue;
    }
    
    // Only take items from last 24 hours
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const sortedItems = items
      .filter(item => item.title && item.link)
      .filter(item => item.pubDate && item.pubDate.getTime() > oneDayAgo)
      .sort((a, b) => {
        if (!a.pubDate || !b.pubDate) return 0;
        return b.pubDate.getTime() - a.pubDate.getTime();
      })
      .slice(0, 10);  // Allow more since we're filtering by time
    
    let added = 0;
    let skipped = 0;
    
    for (const item of sortedItems) {
      // Check if idea already exists globally
      let ideaId = ideaExistsByUrl(item.link);
      
      if (ideaId) {
        skipped++;
        totalSkipped++;
      } else {
        // Insert new idea
        ideaId = insertIdea({
          title: item.title,
          source: feed.name,
          summary: item.description || `New update from ${feed.name}. Click to read more.`,
          url: item.link,
          category: feed.category,
          sourceFeed: feed.url,
          publishedAt: item.pubDate,
        });
        
        if (ideaId) {
          added++;
          totalNew++;
          console.log(`   ✓ ${item.title.substring(0, 50)}...`);
        }
      }
      
      // Add to pending for each user who has this feed (if idea exists)
      if (ideaId) {
        for (const userId of userIds) {
          addToUserPending(userId, ideaId);
        }
      }
    }
    
    // Update last_fetched
    db.query("UPDATE user_feeds SET last_fetched = CURRENT_TIMESTAMP, last_error = NULL WHERE url = ?").run(feed.url);
    
    console.log(`   Added: ${added}, Existing: ${skipped}, Distributed to ${userIds.length} users\n`);
  }
  
  // Step 3: Cleanup old unswiped items (7+ days)
  console.log("🧹 Cleaning up old items...");
  const deleted = db.query(`
    DELETE FROM user_pending 
    WHERE added_at < datetime('now', '-7 days')
    AND NOT EXISTS (
      SELECT 1 FROM swipes 
      WHERE swipes.user_id = user_pending.user_id 
      AND swipes.idea_id = user_pending.idea_id
    )
  `).run();
  console.log(`   Removed ${deleted.changes} old unswiped items\n`);
  
  // Summary
  console.log("━".repeat(50));
  console.log(`✅ Ingestion complete!`);
  console.log(`   New ideas: ${totalNew}`);
  console.log(`   Already existed: ${totalSkipped}`);
  
  const totalIdeas = db.query("SELECT COUNT(*) as count FROM ideas").get() as { count: number };
  const totalPending = db.query("SELECT COUNT(*) as count FROM user_pending").get() as { count: number };
  console.log(`   Total ideas in DB: ${totalIdeas.count}`);
  console.log(`   Total pending items: ${totalPending.count}`);
}

// Export for use by server.ts refresh endpoint
export async function ingestForUser(userId: number) {
  console.log(`🔄 Refreshing feeds for user ${userId}...\n`);
  
  // Get this user's enabled feeds
  const feeds = db.query(`
    SELECT url, name, category FROM user_feeds 
    WHERE user_id = ? AND enabled = 1
  `).all(userId) as { url: string; name: string; category: string }[];
  
  console.log(`📡 Found ${feeds.length} feeds\n`);
  
  let totalNew = 0;
  
  for (const feed of feeds) {
    console.log(`📰 ${feed.name}`);
    
    const items = await fetchRSS(feed.url);
    if (items.length === 0) {
      console.log("   No items\n");
      continue;
    }
    
    // Only take items from last 24 hours
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const sortedItems = items
      .filter(item => item.title && item.link)
      .filter(item => item.pubDate && item.pubDate.getTime() > oneDayAgo)
      .sort((a, b) => {
        if (!a.pubDate || !b.pubDate) return 0;
        return b.pubDate.getTime() - a.pubDate.getTime();
      })
      .slice(0, 10);
    
    for (const item of sortedItems) {
      let ideaId = ideaExistsByUrl(item.link);
      
      if (!ideaId) {
        ideaId = insertIdea({
          title: item.title,
          source: feed.name,
          summary: item.description || `New update from ${feed.name}.`,
          url: item.link,
          category: feed.category,
          sourceFeed: feed.url,
          publishedAt: item.pubDate,
        });
        if (ideaId) {
          totalNew++;
          console.log(`   ✓ ${item.title.substring(0, 50)}...`);
        }
      }
      
      if (ideaId) {
        addToUserPending(userId, ideaId);
      }
    }
    
    db.query("UPDATE user_feeds SET last_fetched = CURRENT_TIMESTAMP WHERE user_id = ? AND url = ?").run(userId, feed.url);
  }
  
  console.log(`\n✅ Added ${totalNew} new items`);
  return totalNew;
}

// Export default feeds seeding function
export function seedDefaultFeeds(userId: number) {
  console.log(`🌱 Seeding default feeds for user ${userId}`);
  
  for (const feed of DEFAULT_FEEDS) {
    try {
      db.query(`
        INSERT OR IGNORE INTO user_feeds (user_id, url, name, category)
        VALUES (?, ?, ?, ?)
      `).run(userId, feed.url, feed.name, feed.category);
    } catch (e) {
      // Ignore duplicates
    }
  }
  
  console.log(`   Added ${DEFAULT_FEEDS.length} default feeds`);
}

// Run if called directly
if (import.meta.main) {
  ingest().catch(console.error);
}






