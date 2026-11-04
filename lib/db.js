// Shared helpers for the API routes. Uses Vercel Postgres (POSTGRES_URL is set automatically
// when you connect a Postgres database to the project).
import { neon } from "@neondatabase/serverless";

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
export const sql = url ? neon(url) : null;

export const CATS = ["Decompiled", "Uncopylocked", "Custom", "Scripts", "Maps", "UI", "VFX", "Audio", "Packs"];

let schemaReady = null;
export function ensureSchema() {
  if (!sql) return Promise.reject(new Error("Database is not connected. Add Vercel Postgres to this project."));
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS listings (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        cat TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        seller TEXT NOT NULL,
        file_url TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        cat TEXT NOT NULL,
        budget TEXT,
        description TEXT NOT NULL,
        requester TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        buyer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        skill TEXT NOT NULL,
        budget TEXT,
        description TEXT NOT NULL,
        poster TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS proof TEXT`;
    })().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// Simple per-instance rate limit (resets on cold start). Fine for stopping casual spam.
const hits = new Map();
export function limited(req, key, max) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const k = key + ":" + ip, now = Date.now();
  const list = (hits.get(k) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(k, list);
  return list.length > max;
}

// Posts a message to the Discord channel the bot's staff watch (set DISCORD_WEBHOOK_URL).
export async function notify(text) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
  } catch {}
}
