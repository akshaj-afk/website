// One serverless function for all sign-in routes.
// Called as /api/auth?route=discord/login (and so on). vercel.json maps the
// /api/auth/<route> callback URLs to this same function.
// Routes: discord/login, discord/callback, google/login, google/callback, logout
import { randomBytes } from "node:crypto";
import { baseUrl, setCookie, cookie, sign, userGuildMember, VIP_ROLE_ID, redirect, getUser, membership, isAdmin } from "../lib/auth.js";

function fail(res, why) {
  return redirect(res, "/?auth=failed&why=" + encodeURIComponent(why));
}

function discordLogin(req, res) {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return fail(res, "DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET is missing in Vercel environment variables");
  }
  const state = randomBytes(16).toString("hex");
  setCookie(res, "eu_state", state, 600);
  const q = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || "",
    redirect_uri: `${baseUrl(req)}/api/auth/discord/callback`,
    response_type: "code",
    scope: "identify guilds guilds.members.read",
    state,
  });
  return redirect(res, "https://discord.com/oauth2/authorize?" + q);
}

async function discordCallback(req, res) {
  const base = baseUrl(req);
  const u = new URL(req.url, base);
  const code = u.searchParams.get("code");
  if (u.searchParams.get("error")) return fail(res, "Discord returned: " + (u.searchParams.get("error_description") || u.searchParams.get("error")));
  if (!code) return fail(res, "Discord did not send a login code back");
  if (u.searchParams.get("state") !== cookie(req, "eu_state")) return fail(res, "login expired or cookies are blocked. Try again and allow cookies for this site");
  try {
    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || "",
        client_secret: process.env.DISCORD_CLIENT_SECRET || "",
        grant_type: "authorization_code",
        code,
        redirect_uri: `${base}/api/auth/discord/callback`,
      }),
    });
    if (!tok.ok) {
      const detail = (await tok.text()).slice(0, 160);
      return fail(res, `Discord rejected the login (${tok.status}): ${detail}. Check the Client ID, Client Secret and the redirect URL in the Discord portal`);
    }
    const { access_token } = await tok.json();
    const me = await (await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${access_token}` } })).json();
    if (!me.id) return fail(res, "could not read your Discord profile");
    const gm = await userGuildMember(access_token);
    const member = !!(gm && gm.member);
    const vip = !!(gm && gm.member && VIP_ROLE_ID && gm.roles.includes(VIP_ROLE_ID));
    const avatar = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
    setCookie(res, "eu_session", sign({
      p: "discord", id: me.id, name: me.global_name || me.username, username: me.username, avatar, member, vip,
      exp: Date.now() + 7 * 86400000,
    }), 7 * 86400);
    setCookie(res, "eu_state", "", 0);
    return redirect(res, "/?auth=ok");
  } catch (e) {
    return fail(res, "server error during Discord sign-in: " + (e && e.message ? e.message : "unknown"));
  }
}

function googleLogin(req, res) {
  const state = randomBytes(16).toString("hex");
  setCookie(res, "eu_state", state, 600);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: `${baseUrl(req)}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return redirect(res, "https://accounts.google.com/o/oauth2/v2/auth?" + q);
}

async function googleCallback(req, res) {
  const base = baseUrl(req);
  const u = new URL(req.url, base);
  const code = u.searchParams.get("code");
  if (!code || u.searchParams.get("state") !== cookie(req, "eu_state")) return redirect(res, "/?auth=failed");
  try {
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        grant_type: "authorization_code",
        code,
        redirect_uri: `${base}/api/auth/google/callback`,
      }),
    });
    if (!tok.ok) throw new Error("token exchange failed");
    const { access_token } = await tok.json();
    const me = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } })).json();
    // Google sign-in identifies the person; buying, selling and requests still need Discord membership.
    setCookie(res, "eu_session", sign({
      p: "google", id: me.sub, name: me.name || me.email || "Google user", avatar: me.picture || "", member: false,
      exp: Date.now() + 7 * 86400000,
    }), 7 * 86400);
    setCookie(res, "eu_state", "", 0);
    return redirect(res, "/?auth=ok");
  } catch {
    return redirect(res, "/?auth=failed");
  }
}

async function meHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const u = getUser(req);
  if (!u) return res.status(200).json({ user: null });
  const ms = await membership(u);
  return res.status(200).json({ user: { name: u.name, avatar: u.avatar, provider: u.p, member: ms.member, vip: ms.vip, admin: isAdmin(u) } });
}

export default async function handler(req, res) {
  const path = (req.query?.route || new URL(req.url, baseUrl(req)).searchParams.get("route") || "").replace(/\/$/, "");
  switch (path) {
    case "discord/login": return discordLogin(req, res);
    case "discord/callback": return discordCallback(req, res);
    case "google/login": return googleLogin(req, res);
    case "google/callback": return googleCallback(req, res);
    case "me": return meHandler(req, res);
    case "logout":
      setCookie(res, "eu_session", "", 0);
      return redirect(res, "/");
    default:
      return res.status(404).json({ error: "Not found" });
  }
}
