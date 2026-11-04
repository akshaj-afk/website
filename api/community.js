// Community API: posts, jobs, file requests and file listings.
// Called as /api/community?kind=posts|jobs|requests|listings (vercel.json maps the old URLs here).
import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser, membership, isAdmin, grantVipRole } from "../lib/auth.js";

async function listings(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  if (req.method === "GET") {
    // The file link is never sent here; it is only released through /api/orders after payment.
    const rows = await sql`SELECT id, title, cat, price_cents, description, seller, created_at
                           FROM listings WHERE active ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ listings: rows.map(r => ({
      id: r.id, title: r.title, cat: r.cat, price: r.price_cents / 100,
      description: r.description, seller: r.seller, created_at: r.created_at,
    })) });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to do this." });
  if (!user.member) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
  if (limited(req, "listings", 5)) return res.status(429).json({ error: "Too many listings. Try again in a minute." });
  const b = await readBody(req);
  const title = clean(b.title, 80);
  const cat = clean(b.cat, 30);
  const description = clean(b.description ?? b.desc, 300);
  const seller = clean(user.name, 40);
  const fileUrl = clean(b.fileUrl, 500);
  const price = Math.round(Number(b.price) * 100) / 100;

  if (!title || !description || !seller) return res.status(400).json({ error: "Fill in the title, description and your Discord name." });
  if (!CATS.includes(cat)) return res.status(400).json({ error: "Pick a valid category." });
  if (!(price >= 1 && price <= 10000)) return res.status(400).json({ error: "Price must be between $1 and $10,000." });
  if (!/^https:\/\/\S+$/.test(fileUrl)) return res.status(400).json({ error: "Add an https:// link to the file so it can be delivered after payment." });

  const [row] = await sql`INSERT INTO listings (title, cat, price_cents, description, seller, file_url)
                          VALUES (${title}, ${cat}, ${Math.round(price * 100)}, ${description}, ${seller}, ${fileUrl})
                          RETURNING id`;
  await notify(`🛒 New listing #${row.id}: **${title}** (${cat}) for $${price.toFixed(2)} by ${seller}`);
  return res.status(201).json({ id: row.id });
}

async function posts(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }
  if (req.method === "GET") {
    const rows = await sql`SELECT id, text, author, created_at FROM posts ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ posts: rows });
  }
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to do this." });
  if (!user.member) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
  if (limited(req, "posts", 6)) return res.status(429).json({ error: "Slow down. Try again in a minute." });
  const text = clean((await readBody(req)).text, 500);
  if (!text) return res.status(400).json({ error: "Write something first." });
  const [row] = await sql`INSERT INTO posts (text, author) VALUES (${text}, ${clean(user.name, 40)}) RETURNING id`;
  return res.status(201).json({ id: row.id });
}

const SKILLS = ["Scripting", "Building", "UI", "VFX", "Other"];

async function jobs(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }
  if (req.method === "GET") {
    const rows = await sql`SELECT id, title, skill, budget, description, poster, created_at FROM jobs ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ jobs: rows });
  }
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to do this." });
  if (!user.member) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
  if (limited(req, "jobs", 4)) return res.status(429).json({ error: "Slow down. Try again in a minute." });
  const b = await readBody(req);
  const title = clean(b.title, 80), skill = clean(b.skill, 20), budget = clean(b.budget, 40) || null, description = clean(b.description, 300);
  if (!title || !description) return res.status(400).json({ error: "Add a title and description." });
  if (!SKILLS.includes(skill)) return res.status(400).json({ error: "Pick a valid skill." });
  const [row] = await sql`INSERT INTO jobs (title, skill, budget, description, poster)
                          VALUES (${title}, ${skill}, ${budget}, ${description}, ${clean(user.name, 40)}) RETURNING id`;
  await notify(`💼 New job #${row.id}: **${title}** (${skill})${budget ? ` · ${budget}` : ""} posted by ${clean(user.name, 40)}`);
  return res.status(201).json({ id: row.id });
}

async function requests(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  if (req.method === "GET") {
    const rows = await sql`SELECT id, title, cat, budget, description, requester, created_at
                           FROM requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ requests: rows });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to do this." });
  if (!user.member) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
  if (limited(req, "requests", 5)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  const b = await readBody(req);
  const title = clean(b.title, 80);
  const cat = clean(b.cat, 30);
  const budget = clean(b.budget, 40) || null;
  const description = clean(b.description, 300);
  const requester = clean(user.name, 40);

  if (!title || !description || !requester) return res.status(400).json({ error: "Fill in the title, description and your Discord name." });
  if (!CATS.includes(cat)) return res.status(400).json({ error: "Pick a valid category." });

  const [row] = await sql`INSERT INTO requests (title, cat, budget, description, requester)
                          VALUES (${title}, ${cat}, ${budget}, ${description}, ${requester})
                          RETURNING id`;
  await notify(`📥 New file request #${row.id}: **${title}** (${cat})${budget ? ` · budget ${budget}` : ""} from ${requester}`);
  return res.status(201).json({ id: row.id });
}

const KINDS = { listings, posts, jobs, requests };

export default function handler(req, res) {
  const kind = new URL(req.url, "http://x").searchParams.get("kind") || req.query?.kind;
  const fn = KINDS[kind];
  if (!fn) return res.status(404).json({ error: "Not found" });
  return fn(req, res);
}
