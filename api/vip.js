import { ensureSchema, sql, readBody, clean, limited, notify } from "../lib/db.js";
import { getUser, membership } from "../lib/auth.js";

// GET: the signed-in member's latest VIP order.
// POST: submit (or update) VIP payment proof. Staff check it and grant the VIP role in Discord.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try { await ensureSchema(); } catch (e) { return res.status(503).json({ error: e.message }); }

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sign in with Discord to buy VIP." });
  const ms = await membership(user);
  if (!ms.member) return res.status(403).json({ error: "Sign in with Discord and join the server to buy VIP." });

  if (req.method === "GET") {
    const [o] = await sql`SELECT id, method, status, created_at FROM vip_orders
                          WHERE discord_id = ${String(user.id)} ORDER BY created_at DESC LIMIT 1`;
    return res.status(200).json({ order: o || null, vip: ms.vip });
  }
  if (ms.vip) return res.status(409).json({ error: "You already have VIP." });

  if (limited(req, "vip", 5)) return res.status(429).json({ error: "Slow down. Try again in a minute." });
  const b = await readBody(req);
  const method = clean(b.method, 20);
  const proof = clean(b.proof, 300);
  if (!["paypal", "gamepass"].includes(method)) return res.status(400).json({ error: "Pick PayPal or Roblox Gamepass." });
  if (proof.length < 6) return res.status(400).json({ error: "Add your PayPal transaction ID or a link to your receipt screenshot." });

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
  await notify(`💎 VIP proof #${id} from ${name} (${discordId}) paid with ${method}: ${proof}\nStaff: check the payment, then give the VIP role in Discord.`);
  return res.status(201).json({ id });
}
