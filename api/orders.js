import { randomBytes } from "node:crypto";
import { ensureSchema, sql, readBody, clean, limited, notify } from "../lib/db.js";
import { getUser } from "../lib/auth.js";

export default async function handler(req, res) {
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
