/**
 * app.js
 *
 * Hybrid adven195 GSMArena/Engadget -> OpenAI -> Blogger autoposter
 *
 * NOTE: This version implements a Queue Management System (QMS).
 * The RSS feed is fetched and refilled into the 'queued_links' table ONLY when the queue is empty.
 * Each cron run processes one item from the queue, significantly reducing OpenAI cost and API calls.
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { GoogleApis } from 'googleapis';
import OpenAI from 'openai';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Environment Variables (Secrets from GitHub) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS;
// CRON INTERVAL set for posting from the queue (e.g., every 3 hours)
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
// Max items to ADD TO THE QUEUE when refilling the feed (not for posting)
const MAX_QUEUE_FILL = parseInt(process.env.MAX_QUEUE_FILL || '100', 10); 
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase(); 
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in secrets.');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing in secrets.');
  process.exit(1);
}
if (!GSMARENA_RSS) {
    console.error('ERROR: GSMARENA_RSS feed link is missing in secrets. Please update your secret.');
    process.exit(1);
}

// --- API Initialization ---
// Updated parser settings for non-standard/corrupt feeds
const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent', { keepArray: true }],
            ['media:thumbnail', 'mediaThumbnail', { keepArray: true }]
        ]
    },
    xml2jsOptions: {
        strict: false, 
        normalizeTags: true, 
        normalize: true,     
        trim: true           
    }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// --- Database Setup ---
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Table 1: Posted items (To prevent duplicates)
db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    published_at TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// Table 2: Queued links (To manage 24-hour batch processing)
db.prepare(`
  CREATE TABLE IF NOT EXISTS queued_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link TEXT UNIQUE,
    guid TEXT UNIQUE,
    title TEXT
  )
`).run();


function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}

function markPosted({ guid, link, title, published_at }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ? )');
  stmt.run(guid, link, title, published_at || null);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000
    });
    return res.data;
  } catch (e) {
    log('Fetch page error:', e?.message || e);
    return null;
  }
}

function extractFirstImageFromHtml(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

function extractOgImage(html) {
  if (!html) return null;
  const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

function extractMainArticle(html) {
  if (!html) return null;

  // 1. GSMArena (Original)
  let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // 2. Engadget (Original)
  match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];
  
  // 3. Lonely Planet (Example/Common)
  // NOTE: You must inspect the target site's HTML to ensure the class is correct.
  match = html.match(/<div[^>]*class=[\"']article-content[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // Fallback for general article content (common div/article tags)
  match = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (match) return match[1];


  return null;
}

// --- MODIFIED FUNCTION: H1 Heading Generation Removed ---
async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Rewriter. Your task is to rewrite the provided tech news article content into a **unique, high-quality, and SEO-optimized English news post**.

Rules for SEO, Originality, and Token Efficiency:
1.  **Truthful and Original:** The rewritten post must be **100% unique** but must **accurately reflect the facts and context** of the input content. **Do NOT add new factual information** not present in the source.
2.  **Length and Tokens:** The final article should be comprehensive but **not artificially expanded**. Keep the length similar to the original source material. **Avoid unnecessary expansion to save tokens.**
3.  **Structure and SEO:** Use structured subheadings (H2, H3) to improve readability and search engine optimization. **Do NOT generate the main title (H1)**; Blogger handles that automatically.
4.  **Formatting:** Use standard HTML formatting (p, strong, ul, ol).
5.  **Clean Output:** **DO NOT** include any links (hyperlinks/<a> tags). **DO NOT** include any introductory or concluding remarks outside the main article body.
6.  **Language:** Write in professional, clear English only.
7.  **Output Format:** Return **ONLY** the final HTML content for the article body.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nContent:\n${content || ''}` }],
      max_tokens: 1500 
    });
    let text = completion.choices?.[0]?.message?.content || '';

    text = text.replace(/\.\.\.\s*html/gi, '');
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');

    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

// --- Unchanged Support Functions ---
async function generateImageAlt(title, snippet, content) {
  const prompt = `Generate a descriptive image alt text (5-10 words) that **incorporates relevant keywords** and explains what the picture shows based on this article. Only return the alt text.
Title: ${title}
Snippet: ${snippet}
Content: ${content}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40
    });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Alt error:', err?.message || err);
    return title;
  }
}

async function generateImageTitle(title, snippet, content) {
  const prompt = `Generate a short, SEO-friendly title text (3-6 words) for an image in this article. The title should be a **concise, keyword-focused summary**. Only return the title text.
Title: ${title}
Snippet: ${snippet}
Content: ${content}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20
    });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Title error:', err?.message || err);
    return title;
  }
}

async function generateTags(title, snippet, content) {
  const prompt = `Generate 3-6 SEO-friendly tags for this article. Return as comma-separated keywords only.\nTitle: ${title}\nSnippet: ${snippet}\nContent: ${content}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40
    });
    const tags = (completion.choices?.[0]?.message?.content || '').split(',').map(t => t.trim()).filter(Boolean);
    return tags;
  } catch (err) {
    log('Tags error:', err?.message || err);
    return [];
  }
}

async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID,
      requestBody: {
        title,
        content: htmlContent,
        labels: labels.length ? labels : undefined
      }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}
// --- End Unchanged Support Functions ---


// --- MODIFIED processOnce FUNCTION (Queue Logic) ---
async function processOnce() {
    try {
        const nextItemQuery = db.prepare('SELECT * FROM queued_links ORDER BY id ASC LIMIT 1');
        let nextItem = nextItemQuery.get();

        // Check 1: Agar Queue khaali hai to RSS se refill karo
        if (!nextItem) {
            log('Queue is empty. Refilling from RSS feed:', GSMARENA_RSS);
            const feed = await parser.parseURL(GSMARENA_RSS);
            if (!feed?.items?.length) {
                log('No items in feed.');
                return;
            }

            const insertQueueStmt = db.prepare('INSERT OR IGNORE INTO queued_links (guid, link, title) VALUES (?, ?, ?)');
            
            const transaction = db.transaction((items) => {
                let addedCount = 0;
                for (const item of items) {
                    const guid = item.guid || item.link || item.id || item.title;
                    const link = item.link;
                    const title = item.title || 'Untitled';
                    
                    // Dobara post hone se bachne ke liye database mein check karna
                    if (guid && link && !hasBeenPosted(guid) && !hasBeenPosted(link)) {
                        insertQueueStmt.run(guid, link, title);
                        addedCount++;
                    }
                    // Sirf MAX_QUEUE_FILL items ko queue mein daalo
                    if (addedCount >= MAX_QUEUE_FILL) break; 
                }
                log(`Added ${addedCount} new items to the queue.`);
            });
            
            transaction(feed.items);
            nextItem = nextItemQuery.get(); // Refill ke baad dobara agla item uthana
        }
        
        // Agar ab bhi koi item nahi mili to exit
        if (!nextItem) {
            log('No new items found to process.');
            return;
        }

        // Check 2: Agle item ko process karna
        const { link, title, guid } = nextItem;
        log('Processing next queued item:', title);

        let snippet = ''; 
        let fullContent = '';
        let imageUrl = null;
        
        // Step A: Article page ko fetch karna
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
            const extracted = extractMainArticle(pageHtml);
            if (extracted) fullContent = extracted;
            if (!imageUrl) imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
        // Fallback image search
        if (!imageUrl) imageUrl = extractFirstImageFromHtml(fullContent);

        // Step B: Content cleanup (Redundant images and formatting)
        if (fullContent) {
            fullContent = fullContent.replace(/<img[^>]*>/gi, ''); 
            fullContent = fullContent.replace(/[\r\n]+/g, ' '); 
        }

        // Step C: OpenAI Rewrite
        let rewrittenHtml = '';
        try {
            rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });
        } catch (e) {
            log('OpenAI rewrite failed for queued item:', title);
            // Failed item ko queue se hata dena chahiye taaki woh dobara process na ho
            db.prepare('DELETE FROM queued_links WHERE id = ?').run(nextItem.id); 
            return; 
        }

        // Step D: Final HTML aur Tags
        let finalHtml = '';
        if (imageUrl) {
            const altText = await generateImageAlt(title, snippet, fullContent);
            const titleText = await generateImageTitle(title, snippet, fullContent);
            finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
        }
        finalHtml += rewrittenHtml;

        const tags = await generateTags(title, snippet, fullContent);

        // Step E: Post to Blogger
        let posted;
        try {
            posted = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
        } catch (e) {
            log('Failed to post to Blogger for:', title);
            // Failed item ko queue se hata dena chahiye
            db.prepare('DELETE FROM queued_links WHERE id = ?').run(nextItem.id);
            return;
        }

        // Step F: Cleanup and Mark Posted
        log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');
        
        db.prepare('DELETE FROM queued_links WHERE id = ?').run(nextItem.id); 
        markPosted({ guid, link, title, published_at: new Date().toISOString() }); 
        
        await sleep(2000); 

        if (MODE === 'once') {
            log('MODE=once: exiting after one post.');
            return;
        }

    } catch (err) {
        log('processOnce error:', err?.message || err);
    }
}
// --- END MODIFIED processOnce FUNCTION ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH, POST_INTERVAL_CRON });
  if (MODE === 'once') {
    await processOnce();
    log('Finished single run. Exiting.');
    process.exit(0);
  } else {
    log('Scheduling cron:', POST_INTERVAL_CRON);
    // Start with one immediate run
    await processOnce();
    // Schedule subsequent runs
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume();
  }
}

start().catch(e => { log('Fatal error:', e?.message || e); process.exit(1); });
  
