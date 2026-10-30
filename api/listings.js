import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser } from "../lib/auth.js";

export default async function handler(req, res) {
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
