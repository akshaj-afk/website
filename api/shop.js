// Shop API: orders and proof of payment.
// Called as /api/shop?kind=orders|proof (vercel.json maps the old URLs here).
import { randomBytes } from "node:crypto";
import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser, membership, isAdmin, grantVipRole } from "../lib/auth.js";

async function orders(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  if (req.method === "GET") {
    // Buyers check their order with the code shown when they ordered. The file link is only
    // returned once staff have marked the order delivered.
    const code = clean(new URL(req.url, "http://x").searchParams.get("code"), 16).toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(code)) return res.status(400).json({ error: "Enter a valid order code." });
    const [o] = await sql`SELECT o.id, o.status, l.title, l.price_cents, l.file_url
                          FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.code = ${code}`;
    if (!o) return res.status(404).json({ error: "Order not found." });
    return res.status(200).json({
      id: o.id, status: o.status,
      listing: { title: o.title, price: o.price_cents / 100 },
      fileUrl: o.status === "delivered" ? o.file_url : null,
    });
  }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to do this." });
  if (!user.member) return res.status(403).json({ error: "Sign in with Discord and join the server to do this." });
  if (limited(req, "orders", 5)) return res.status(429).json({ error: "Too many orders. Try again in a minute." });
  const b = await readBody(req);
  const listingId = Number(b.listingId);
  const buyer = clean(user.name, 40);
  if (!Number.isInteger(listingId) || !buyer) return res.status(400).json({ error: "Choose a file and enter your Discord name." });

  const [l] = await sql`SELECT id, title, price_cents, seller FROM listings WHERE id = ${listingId} AND active`;
  if (!l) return res.status(404).json({ error: "That listing is no longer available." });

  const code = randomBytes(4).toString("hex").toUpperCase();
  const [o] = await sql`INSERT INTO orders (code, listing_id, buyer) VALUES (${code}, ${l.id}, ${buyer}) RETURNING id`;
  await notify(`🧾 New order #${o.id}: **${l.title}** ($${(l.price_cents / 100).toFixed(2)}) from ${buyer}, seller ${l.seller}. Staff: confirm payment with /order_status.`);
  return res.status(201).json({ id: o.id, code });
}

async function proof(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }
  if (limited(req, "proof", 5)) return res.status(429).json({ error: "Slow down. Try again in a minute." });
  const b = await readBody(req);
  const code = clean(b.code, 16).toUpperCase();
  const proof = clean(b.proof, 300);
  if (!/^[A-F0-9]{8}$/.test(code)) return res.status(400).json({ error: "Enter a valid order code." });
  if (proof.length < 6) return res.status(400).json({ error: "Add a link or transaction ID as proof." });
  const [o] = await sql`UPDATE orders SET proof = ${proof} WHERE code = ${code} AND status IN ('pending', 'paid')
                        RETURNING id, buyer`;
  if (!o) return res.status(404).json({ error: "Order not found or already closed." });
  await notify(`🧾 Proof submitted for order #${o.id} by ${o.buyer}: ${proof}\nStaff: check the payment, then use /order_status.`);
  return res.status(200).json({ ok: true });
}

const KINDS = { orders, proof };

export default function handler(req, res) {
  const kind = new URL(req.url, "http://x").searchParams.get("kind") || req.query?.kind;
  const fn = KINDS[kind];
  if (!fn) return res.status(404).json({ error: "Not found" });
  return fn(req, res);
}
