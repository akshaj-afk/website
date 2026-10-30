import { ensureSchema, sql, readBody, clean, limited, notify, CATS } from "../lib/db.js";
import { getUser } from "../lib/auth.js";

export default async function handler(req, res) {
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
