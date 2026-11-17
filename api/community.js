// Community API: posts, jobs, file requests and file listings.
// Called as /api/community?kind=posts|jobs|requests|listings|files|ticketcheck
import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser, membership, isAdmin } from "../lib/auth.js";
import {
  discordApi, ticketConfig, botUserId, createTicketChannel, deleteChannelQuietly, friendlyDiscordError, PERM,
} from "../lib/discord.js";
import { put } from "@vercel/blob";

// A failed staff alert must not make a saved submission look like it failed.
const alert = (msg) => Promise.resolve().then(() => notify(msg)).catch((e) => console.error("notify failed:", e));

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
  if (!user.member && !isAdmin(user)) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
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
  await alert(`🛒 New listing #${row.id}: **${title}** (${cat}) for $${price.toFixed(2)} by ${seller}`);
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

// Accepts any capitalization, so "scripting", "UI" and "vfx" all work.
const SKILLS = { scripting: "Scripting", building: "Building", ui: "UI", vfx: "VFX", other: "Other" };

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

  // Validate first, so a bad form submission does not count against the rate limit.
  const b = (await readBody(req)) || {};
  const title = clean(b.title, 80);
  const skill = SKILLS[clean(b.skill, 30).toLowerCase()];
  const budget = clean(b.budget, 40) || null;
  const description = clean(b.description ?? b.desc, 300);
  if (!title || !description) return res.status(400).json({ error: "Add a title and description." });
  if (!skill) return res.status(400).json({ error: "Pick a valid skill: Scripting, Building, UI, VFX or Other." });
  if (limited(req, "jobs", 4)) return res.status(429).json({ error: "Slow down. Try again in a minute." });

  const poster = clean(user.name, 40);
  const [row] = await sql`INSERT INTO jobs (title, skill, budget, description, poster)
                          VALUES (${title}, ${skill}, ${budget}, ${description}, ${poster}) RETURNING id`;
  await alert(`💼 New job #${row.id}: **${title}** (${skill})${budget ? ` · ${budget}` : ""} posted by ${poster}`);
  return res.status(201).json({ id: row.id });
}

const REQUEST_CATS = ["Scripting", "Building", "UI", "VFX", "Other"];

// File requests. Order of operations:
//   1. Check sign-in and live server membership.
//   2. Validate the form.
//   3. Save the request as 'pending' in Neon so it has an ID for the buttons.
//   4. Create the Discord channel and post the ticket message.
//   5. Mark the request 'open' with the channel ID.
// If step 4 or 5 fails, the channel is removed and the request is marked 'failed'.
// The response is 201 only when the ticket exists in Discord and the database.
async function requests(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  if (req.method === "GET") {
    const rows = await sql`SELECT id, title, cat, budget, description, requester, created_at
                           FROM requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`;
    return res.status(200).json({ requests: rows });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to request a file." });
  // Live check (cached 60s) instead of trusting the membership flag saved in the cookie at sign-in.
  const ms = await membership(user);
  if (!ms.member) return res.status(403).json({ error: "Sign in with Discord and join the server to request a file." });

  const b = (await readBody(req)) || {};
  const title = clean(b.title, 80);
  const cat = clean(b.cat, 30);
  const budget = clean(b.budget, 40) || "Not given";
  const description = clean(b.description ?? b.desc, 300);
  if (!title || !description) return res.status(400).json({ error: "Fill in the title and description." });
  if (!REQUEST_CATS.includes(cat)) return res.status(400).json({ error: "Pick a valid category." });
  if (limited(req, "requests", 5)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });

  const cfg = ticketConfig();
  if (cfg.problems.length) {
    console.error("[ticket] configuration problem:", cfg.problems.join("; "));
    return res.status(500).json({ error: "The ticket system is not configured yet. The site admin needs to check the Vercel environment variables." });
  }

  const requester = clean(user.name, 40);
  const requesterId = String(user.id);
  const [row] = await sql`INSERT INTO requests (title, cat, budget, description, requester, requester_id, status)
                          VALUES (${title}, ${cat}, ${budget}, ${description}, ${requester}, ${requesterId}, 'pending')
                          RETURNING id`;
  const requestId = row.id;

  let channel = null;
  try {
    channel = await createTicketChannel({
      cfg,
      ticket: { id: requestId, title, cat, budget, description, requester, requester_id: requesterId, status: "open", claimed_by: null },
    });
    await sql`UPDATE requests SET status = 'open', channel_id = ${channel.id}, message_id = ${channel.messageId}
              WHERE id = ${requestId}`;
  } catch (e) {
    console.error(`[ticket] request #${requestId} was not opened:`, e && e.message ? e.message : e);
    if (channel) await deleteChannelQuietly(channel.id, requestId);
    const reason = friendlyDiscordError(e);
    await sql`UPDATE requests SET status = 'failed', error = ${reason} WHERE id = ${requestId}`
      .catch(err => console.error("[ticket] could not mark request as failed:", err.message));
    return res.status(502).json({ error: `${reason} No ticket was left behind, so please try again.`, code: (e && e.code) || null });
  }

  return res.status(201).json({
    id: requestId,
    channelId: channel.id,
    url: channel.url,
    message: "Your request ticket is open in Discord.",
  });
}

// Admin-only diagnostics. Open /api/community?kind=ticketcheck while signed in as the admin.
// It checks each setting against Discord and reports pass/fail without showing any secret.
async function ticketcheck(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isAdmin(getUser(req))) return res.status(403).json({ error: "Admins only." });

  const cfg = ticketConfig();
  const out = { config: cfg.problems.length ? cfg.problems : "ok" };
  const check = async (name, fn) => {
    try { out[name] = { ok: true, ...(await fn()) }; }
    catch (e) { out[name] = { ok: false, detail: e.message, hint: friendlyDiscordError(e) }; }
  };

  await check("bot", async () => {
    const me = await discordApi("GET", "/users/@me");
    return { id: me.id, username: me.username };
  });
  if (cfg.problems.length) return res.status(200).json(out);

  await check("guild", async () => {
    const g = await discordApi("GET", `/guilds/${cfg.guild}`);
    return { name: g.name };
  });
  await check("category", async () => {
    const c = await discordApi("GET", `/channels/${cfg.category}`);
    return { name: c.name, isCategory: c.type === 4, inThisGuild: c.guild_id === cfg.guild };
  });
  await check("supportRole", async () => {
    const roles = await discordApi("GET", `/guilds/${cfg.guild}/roles`);
    const r = roles.find(x => x.id === cfg.staffRole);
    if (!r) throw new Error("no role with that ID exists in this server");
    return { name: r.name };
  });
  await check("botPermissions", async () => {
    const id = await botUserId();
    const roles = await discordApi("GET", `/guilds/${cfg.guild}/roles`);
    const member = await discordApi("GET", `/guilds/${cfg.guild}/members/${id}`);
    const byId = new Map(roles.map(r => [r.id, BigInt(r.permissions)]));
    let perms = byId.get(cfg.guild) || 0n;
    for (const rid of member.roles) perms |= byId.get(rid) || 0n;
    const has = (bit) => (perms & 8n) !== 0n || (perms & BigInt(bit)) !== 0n;
    return {
      canManageChannels: has(PERM.MANAGE_CHANNELS),
      canView: has(PERM.VIEW),
      canSend: has(PERM.SEND),
      canReadHistory: has(PERM.HISTORY),
      note: "Server-wide permissions only. Category overrides are not included.",
    };
  });

  return res.status(200).json(out);
}

async function files(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  if (req.method === "GET") {
    const rows = await sql`SELECT id, title, cat, description, file_name, size, url, uploader, created_at
                           FROM public_files ORDER BY created_at DESC LIMIT 200`;
    return res.status(200).json({ files: rows });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to upload." });
  if (!user.member && !isAdmin(user)) return res.status(403).json({ error: "Sign in with Discord and join the server to upload." });
  if (limited(req, "files", 4)) return res.status(429).json({ error: "Slow down. Try again in a minute." });

  const b = await readBody(req);
  const title = clean(b.title, 80);
  const cat = clean(b.cat, 30);
  const description = clean(b.description, 300);
  const fileName = clean(b.fileName, 120).replace(/[^\w.\- ]/g, "_") || "file";
  const contentType = clean(b.contentType, 100) || "application/octet-stream";
  if (!title) return res.status(400).json({ error: "Add a title." });
  if (!CATS.includes(cat)) return res.status(400).json({ error: "Pick a valid category." });
  if (typeof b.data !== "string" || !b.data) return res.status(400).json({ error: "Choose a file first." });

  const buf = Buffer.from(b.data, "base64");
  if (buf.length === 0) return res.status(400).json({ error: "The file is empty." });
  if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ error: "Files must be 3 MB or smaller." });

  const blob = await put(`public-files/${Date.now()}-${fileName}`, buf, { access: "public", contentType });
  const uploader = clean(user.name, 40);
  const [row] = await sql`INSERT INTO public_files (title, cat, description, file_name, size, url, uploader)
                          VALUES (${title}, ${cat}, ${description}, ${fileName}, ${buf.length}, ${blob.url}, ${uploader})
                          RETURNING id`;
  await alert(`📁 New public file #${row.id}: **${title}** (${cat}) by ${uploader}`);
  return res.status(201).json({ id: row.id, url: blob.url });
}

const KINDS = { listings, posts, jobs, requests, files, ticketcheck };

export default function handler(req, res) {
  const kind = new URL(req.url, "http://x").searchParams.get("kind") || req.query?.kind;
  const fn = KINDS[kind];
  if (!fn) return res.status(404).json({ error: "Not found" });
  return fn(req, res);
}
