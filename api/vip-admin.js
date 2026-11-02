import { ensureSchema, sql, readBody, notify } from "../lib/db.js";
import { getUser, isAdmin, grantVipRole } from "../lib/auth.js";

// Admin only (ADMIN_USERNAME). GET lists pending VIP orders. POST approves or rejects one.
export default async function handler(req, res) {
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
    await notify(`❌ VIP order #${id} from ${o.discord_name} was rejected by ${user.username}.`);
    return res.status(200).json({ ok: true, status: "rejected", granted: false });
  }

  // Approve: give the role if the bot token is set. Otherwise staff grant it by hand.
  const grant = await grantVipRole(o.discord_id, `VIP order #${id} approved on the website by ${user.username}`);
  if (!grant.ok && !String(grant.error).startsWith("missing")) {
    return res.status(502).json({ error: "Couldn't give the VIP role. Check the member is in the server and the bot's role is above VIP." });
  }
  await sql`UPDATE vip_orders SET status = 'approved' WHERE id = ${id}`;
  await notify(`✅ VIP order #${id} for ${o.discord_name} approved by ${user.username}.${grant.ok ? " Role given." : " Give the VIP role by hand."}`);
  return res.status(200).json({
    ok: true, status: "approved", granted: grant.ok,
    note: grant.ok ? "Approved and the VIP role was given." : "Approved. Give the VIP role by hand (bot token not set).",
  });
}
