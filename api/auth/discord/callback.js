import { baseUrl, setCookie, cookie, sign, isMember, redirect } from "../../../lib/auth.js";

export default async function handler(req, res) {
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
