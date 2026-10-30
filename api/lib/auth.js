// Session helpers. The session is a signed cookie (HMAC with SESSION_SECRET), so no database is needed.
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SESSION_SECRET || "";
export const GUILD_INVITE = "2D4KTvA9Sh";

export function baseUrl(req) {
  return (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
}

export function sign(obj) {
  if (!SECRET) throw new Error("SESSION_SECRET is not set");
  const data = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return data + "." + createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function unsign(token) {
  if (!SECRET || !token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const want = Buffer.from(createHmac("sha256", SECRET).update(data).digest("base64url"));
  const got = Buffer.from(sig || "");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const o = JSON.parse(Buffer.from(data, "base64url").toString());
    return o.exp && Date.now() > o.exp ? null : o;
  } catch { return null; }
}

export function cookie(req, name) {
  const m = (req.headers.cookie || "").split(";").map(c => c.trim()).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export function setCookie(res, name, value, maxAge) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(prev ? [].concat(prev) : []), c]);
}

export function getUser(req) { return unsign(cookie(req, "eu_session")); }

export function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
}

let guildCache = null;
export async function guildId() {
  if (guildCache) return guildCache;
  const r = await fetch(`https://discord.com/api/v10/invites/${GUILD_INVITE}`);
  if (!r.ok) return null;
  const j = await r.json();
  guildCache = j.guild?.id || null;
  return guildCache;
}

// Checks the signed-in Discord user's server list for our server.
export async function isMember(accessToken) {
  const gid = await guildId();
  if (!gid) return false;
  const r = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return false;
  const guilds = await r.json();
  return Array.isArray(guilds) && guilds.some(g => g.id === gid);
}
