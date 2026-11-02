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

// ---- Roles and admin -------------------------------------------------------
// VIP_ROLE_ID: the Discord role ID of VIP (copy it from the server's role settings).
// ADMIN_USERNAME: the Discord username allowed to approve VIP orders on the site.
// DISCORD_BOT_TOKEN: the bot's token. Used to read roles live and to give the VIP role.
export const VIP_ROLE_ID = (process.env.VIP_ROLE_ID || "").trim();
export const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "legend_demon_404").trim().toLowerCase();

export function isAdmin(user) {
  return !!user && typeof user.username === "string" && user.username.toLowerCase() === ADMIN_USERNAME;
}

// Reads a member's roles with the bot token. Returns null if the bot token is not set or Discord fails.
export async function botGuildMember(userId) {
  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  const gid = await guildId();
  if (!token || !gid) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${gid}/members/${userId}`, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 404) return { member: false, roles: [] };
    if (!r.ok) return null;
    const j = await r.json();
    return { member: true, roles: j.roles || [] };
  } catch { return null; }
}

// Reads the signed-in user's own membership (needs the guilds.members.read scope). Used at sign-in.
export async function userGuildMember(accessToken) {
  const gid = await guildId();
  if (!gid) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${gid}/member`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (r.status === 404) return { member: false, roles: [] };
    if (!r.ok) return null;
    const j = await r.json();
    return { member: true, roles: j.roles || [] };
  } catch { return null; }
}

// Live membership: bot token first (cached 60s), otherwise the values saved at sign-in.
const memberCache = new Map();
export async function membership(user) {
  if (!user) return { member: false, vip: false };
  const hit = memberCache.get(user.id);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const live = await botGuildMember(user.id);
  const v = live === null
    ? { member: !!user.member, vip: !!user.vip }
    : { member: live.member, vip: live.member && !!VIP_ROLE_ID && live.roles.includes(VIP_ROLE_ID) };
  memberCache.set(user.id, { t: Date.now(), v });
  return v;
}

// Gives the VIP role with the bot token. Returns { ok, error }.
export async function grantVipRole(discordId, reason) {
  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  const gid = await guildId();
  if (!token || !gid || !VIP_ROLE_ID) return { ok: false, error: "missing bot token or VIP_ROLE_ID" };
  const r = await fetch(`https://discord.com/api/v10/guilds/${gid}/members/${discordId}/roles/${VIP_ROLE_ID}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "X-Audit-Log-Reason": encodeURIComponent(reason) },
  });
  if (r.ok || r.status === 204) return { ok: true };
  return { ok: false, error: `Discord returned ${r.status}` };
}
