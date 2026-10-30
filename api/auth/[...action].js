// One serverless function for all sign-in routes, to stay under Vercel's Hobby function limit.
// Routes: /api/auth/discord/login, /api/auth/discord/callback,
//         /api/auth/google/login,  /api/auth/google/callback, /api/auth/logout
import { randomBytes } from "node:crypto";
import { baseUrl, setCookie, cookie, sign, isMember, redirect } from "../../lib/auth.js";

function discordLogin(req, res) {
  const state = randomBytes(16).toString("hex");
  setCookie(res, "eu_state", state, 600);
  const q = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || "",
    redirect_uri: `${baseUrl(req)}/api/auth/discord/callback`,
    response_type: "code",
    scope: "identify guilds",
    state,
  });
  return redirect(res, "https://discord.com/oauth2/authorize?" + q);
}

async function discordCallback(req, res) {
  const base = baseUrl(req);
  const u = new URL(req.url, base);
  const code = u.searchParams.get("code");
  if (!code || u.searchParams.get("state") !== cookie(req, "eu_state")) return redirect(res, "/?auth=failed");
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
    if (!tok.ok) throw new Error("token exchange failed");
    const { access_token } = await tok.json();
    const me = await (await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${access_token}` } })).json();
    const member = await isMember(access_token);
    const avatar = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
    setCookie(res, "eu_session", sign({
      p: "discord", id: me.id, name: me.global_name || me.username, avatar, member,
      exp: Date.now() + 7 * 86400000,
    }), 7 * 86400);
    setCookie(res, "eu_state", "", 0);
    return redirect(res, "/?auth=ok");
  } catch {
    return redirect(res, "/?auth=failed");
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

export default async function handler(req, res) {
  const path = new URL(req.url, baseUrl(req)).pathname.replace(/^\/api\/auth\//, "").replace(/\/$/, "");
  switch (path) {
    case "discord/login": return discordLogin(req, res);
    case "discord/callback": return discordCallback(req, res);
    case "google/login": return googleLogin(req, res);
    case "google/callback": return googleCallback(req, res);
    case "logout":
      setCookie(res, "eu_session", "", 0);
      return redirect(res, "/");
    default:
      return res.status(404).json({ error: "Not found" });
  }
}
