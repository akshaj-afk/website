import { ensureSchema, sql, readBody, clean, limited, notify } from "../lib/db.js";
import { getUser } from "../lib/auth.js";

export default async function handler(req, res) {
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
