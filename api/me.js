import { getUser } from "../lib/auth.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const u = getUser(req);
  res.status(200).json({ user: u ? { name: u.name, avatar: u.avatar, provider: u.p, member: !!u.member } : null });
}
