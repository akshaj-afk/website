import { getUser, membership, isAdmin } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const u = getUser(req);
  if (!u) return res.status(200).json({ user: null });
  const ms = await membership(u);
  res.status(200).json({ user: {
    name: u.name, avatar: u.avatar, provider: u.p,
    member: ms.member, vip: ms.vip, admin: isAdmin(u),
  } });
}
