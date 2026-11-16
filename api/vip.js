// VIP API: a member's VIP order (GET/POST), and admin approvals (?admin=1).
// vercel.json maps /api/vip-admin to /api/vip?admin=1.
import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser, membership, isAdmin, grantVipRole } from "../lib/auth.js";

// A failed staff alert must not make a saved submission look like it failed.
const alert = (msg) => Promise.resolve().then(() => notify(msg)).catch((e) => console.error("notify failed:", e));

// Accepts any capitalization or spacing the form might send, e.g. "PayPal", "Roblox Gamepass".
const METHODS = { paypal: "paypal", gamepass: "gamepass", "roblox gamepass": "gamepass", roblox: "gamepass" };
const HELP = "If this keeps happening, DM @legend_demon_404 on Discord.";
const BUY = "To buy VIP, go to the VIP page on the website.";

async function vipMember(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: `Database is unavailable. ${HELP}` }); }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: `Sign in with Discord first. ${BUY}` });
  const ms = await membership(user);
  if (!ms.member) return res.status(403).json({ error: `Join the Discord server, then come back. ${BUY}` });

  if (req.method === "GET") {
    const [o] = await sql`SELECT id, method, status, created_at FROM vip_orders
                          WHERE discord_id = ${String(user.id)} ORDER BY created_at DESC LIMIT 1`;
    return res.status(200).json({ order: o || null, vip: ms.vip });
  }
  if (ms.vip) return res.status(409).json({ error: "You already have VIP. Enjoy!" });

  // Validate first, so a bad form submission does not count against the rate limit.
  const b = (await readBody(req)) || {};
  const method = METHODS[clean(b.method, 40).toLowerCase()];
  const proof = clean(b.proof, 300);
  if (!method) return res.status(400).json({ error: "Pick PayPal or Roblox Gamepass to buy VIP." });
  if (proof.length < 6) return res.status(400).json({ error: "Add your PayPal transaction ID or a link to your receipt screenshot." });
  if (limited(req, "vip", 5)) return res.status(429).json({ error: "Slow down. Try again in a minute." });

  const discordId = String(user.id);
  const name = clean(user.name, 40);
  const [open] = await sql`SELECT id FROM vip_orders WHERE discord_id = ${discordId} AND status = 'pending' ORDER BY created_at DESC LIMIT 1`;
  let id;
  if (open) {
    const [row] = await sql`UPDATE vip_orders SET method = ${method}, proof = ${proof} WHERE id = ${open.id} RETURNING id`;
    id = row.id;
  } else {
    const [row] = await sql`INSERT INTO vip_orders (discord_id, discord_name, method, proof)
                            VALUES (${discordId}, ${name}, ${method}, ${proof}) RETURNING id`;
    id = row.id;
  }
  await alert(`💎 VIP proof #${id} from ${name} (${discordId}) paid with ${method}: ${proof}\nStaff: check the payment, then give the VIP role in Discord.`);
  return res.status(201).json({ id });
}

async function vipAdmin(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  const user = getUser(req);
  if (!isAdmin(user)) return res.status(403).json({ error: "Admins only." });

  if (req.method === "GET") {
    const orders = await sql`SELECT id, discord_id, discord_name, method, proof, status, created_at
                             FROM vip_orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`;
    return res.status(200).json({ orders });
  }

  const b = await readBody(req);
  const id = Number(b.id);
  const action = b.action;
  if (!Number.isInteger(id) || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "Send an order id and an action (approve or reject)." });
  }
  const [o] = await sql`SELECT id, discord_id, discord_name, status FROM vip_orders WHERE id = ${id}`;
  if (!o) return res.status(404).json({ error: "Order not found." });
  if (o.status !== "pending") return res.status(409).json({ error: `Order is already ${o.status}.` });

  if (action === "reject") {
    await sql`UPDATE vip_orders SET status = 'rejected' WHERE id = ${id}`;
    await alert(`❌ VIP order #${id} from ${o.discord_name} was rejected by ${user.username}.`);
    return res.status(200).json({ ok: true, status: "rejected", granted: false });
  }

  // Approve: give the role if the bot token is set. Otherwise staff grant it by hand.
  const grant = await grantVipRole(o.discord_id, `VIP order #${id} approved on the website by ${user.username}`);
  if (!grant.ok && !String(grant.error).startsWith("missing")) {
    return res.status(502).json({ error: `Couldn't give the VIP role. Check the member is in the server and the bot's role is above VIP. ${HELP}` });
  }
  await sql`UPDATE vip_orders SET status = 'approved' WHERE id = ${id}`;
  await alert(`✅ VIP order #${id} for ${o.discord_name} approved by ${user.username}.${grant.ok ? " Role given." : " Give the VIP role by hand."}`);
  return res.status(200).json({
    ok: true, status: "approved", granted: grant.ok,
    note: grant.ok ? "Approved and the VIP role was given." : "Approved. Give the VIP role by hand (bot token not set).",
  });
}

export default async function handler(req, res) {
  try {
    const admin = new URL(req.url, "http://x").searchParams.get("admin") || req.query?.admin;
    return await (admin ? vipAdmin(req, res) : vipMember(req, res));
  } catch (e) {
    console.error("VIP error:", e);
    if (!res.headersSent) return res.status(500).json({ error: `Something went wrong. ${HELP}` });
  }
}
