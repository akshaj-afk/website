import { baseUrl, setCookie, cookie, sign, redirect } from "../../../lib/auth.js";

export default async function handler(req, res) {
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
