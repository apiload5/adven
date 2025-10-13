/**
 * app.js
 *
 * Hybrid GSMArena/Engadget -> OpenAI -> Blogger autoposter
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS;
// CRON INTERVAL SET TO A SAFE 3-HOUR INTERVAL FOR TRIAL (8 RUNS/DAY)
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
// MAX ITEMS SET TO 1 TO AVOID BURSTING THE TRIAL LIMIT
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase(); // Changed default mode to 'cron'
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing');
  process.exit(1);
}

// Naya Parser configuration: Strictness off (false) karne se woh ghaltiyon ko ignore kar dega.
const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent', { keepArray: true }],
            ['media:thumbnail', 'mediaThumbnail', { keepArray: true }]
        ]
    },
    // Yeh sabse zaroori setting hai: Agar XML parsing mein ghalti ho to fail na ho.
    xml2jsOptions: {
        strict: false 
    }
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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

  // GSMArena
  let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // Engadget
  match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  return null;
}

// --- MODIFIED FUNCTION FOR UNIQUE, TRUTHFUL, AND TOKEN-SAVING REWRITE ---
async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Rewriter. Your task is to rewrite the provided tech news article content into a **unique, high-quality, and SEO-optimized English news post**.

Rules for SEO, Originality, and Token Efficiency:
1.  **Truthful and Original:** The rewritten post must be **100% unique** (not duplicate content) but must **accurately reflect the facts and context** of the input content. **Do NOT add new factual information** not present in the source.
2.  **Length and Tokens:** The final article should be comprehensive but **not artificially expanded**. Keep the length similar to the original source material while ensuring all key points are covered. **Avoid unnecessary expansion to save tokens.**
3.  **Structure and SEO:** Use a compelling main headline (H1) and structured subheadings (H2, H3) to improve readability and search engine optimization.
4.  **Formatting:** Use standard HTML formatting (p, strong, ul, ol).
5.  **Clean Output:** **DO NOT** include any links (hyperlinks/<a> tags). **DO NOT** include any introductory or concluding remarks outside the main article body.
6.  **Language:** Write in professional, clear English only.
7.  **Output Format:** Return **ONLY** the final HTML content for the article body.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nContent:\n${content || ''}` }],
      // Adjusted max_tokens for a reasonable, non-expanded article
      max_tokens: 1500 
    });
    let text = completion.choices?.[0]?.message?.content || '';

    // Existing cleanup steps (important for safety)
    text = text.replace(/\.\.\.\s*html/gi, '');
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');

    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

// --- MODIFIED FUNCTION FOR SEO-FOCUSED ALT TEXT ---
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

// --- MODIFIED FUNCTION FOR SEO-FOCUSED IMAGE TITLE ---
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
  // Model kept at gpt-4o-mini for cost-efficiency
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

async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) {
      log('No items in feed.');
      return;
    }

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link || item.id || item.title;
      const link = item.link;
      const title = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', title);
        continue;
      }

      log('Processing new item:', title);

      let snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;
      let imageUrl = null;

      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) fullContent = extracted;
          if (!imageUrl) imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
      }
      if (!imageUrl) imageUrl = extractFirstImageFromHtml(fullContent);

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });
      } catch (e) {
        log('OpenAI rewrite failed:', title);
        continue;
      }

      let finalHtml = '';
      if (imageUrl) {
        // --- Single Image with SEO-Optimized Alt/Title (Cost-Effective) ---
        const altText = await generateImageAlt(title, snippet, fullContent);
        const titleText = await generateImageTitle(title, snippet, fullContent);
        finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
      }
      finalHtml += rewrittenHtml;

      const tags = await generateTags(title, snippet, fullContent);

      let posted;
      try {
        posted = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');
      markPosted({ guid, link, title, published_at: item.pubDate || item.isoDate || null });
      await sleep(2000);

      if (MODE === 'once') {
        log('MODE=once: exiting after one post.');
        return;
      }
    }
  } catch (err) {
    log('processOnce error:', err?.message || err);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH });
  if (MODE === 'once') {
    await processOnce();
    log('Finished single run. Exiting.');
    process.exit(0);
  } else {
    log('Scheduling cron:', POST_INTERVAL_CRON);
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume();
  }
}

start().catch(e => { log('Fatal error:', e?.message || e); process.exit(1); });
