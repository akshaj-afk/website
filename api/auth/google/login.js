import { randomBytes } from "node:crypto";
import { baseUrl, setCookie, redirect } from "../../../lib/auth.js";

export default function handler(req, res) {
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
