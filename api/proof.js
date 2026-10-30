import { ensureSchema, sql, readBody, clean, limited, notify } from "../lib/db.js";

// Buyers send proof of payment with their order code. Staff review it in Discord and mark the order.
export default async function handler(req, res) {
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
