import { randomBytes } from "node:crypto";
import { baseUrl, setCookie, redirect } from "../../../lib/auth.js";

export default function handler(req, res) {
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
