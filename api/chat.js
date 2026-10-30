// Vercel serverless function: POST /api/chat
// Keeps your OpenRouter key on the server. Set these in Vercel:
//   OPENROUTER_API_KEY  (required)
//   OPENROUTER_MODEL    (optional, default "openrouter/auto")

const SYSTEM = `You are the assistant for Elite Uncopylocked, a Roblox creator community. Answer clearly and concisely. You help with Luau and Roblox scripting, game systems, UI, building, and using this community's site and bot.
Facts you may state: Owner is Legend (@legend_demon_404). Chief and Bot Developer is Magma (@magmafox63911). Questions go to @magmafox63911.
Bot slash commands (the only commands that exist): /setup, /welcomesetup, /boostrolesetup, /ticketpanel, /ticketsetup, /aichatsetup, /aichatoff, /balance, /chatstats, /daily, /pay, /payment, /tickets, /closeticket, /rank, /leaderboard, /addword, /removeword, /listwords, /modtoggle, /manexinfo, /dbstatus. Never invent other commands.
Bot features: economy, leveling and ranks, ticket and payment tickets, moderation, giveaways, backup, reaction roles, boost rewards, welcome messages.
VIP: members get a VIP ID such as VIP-1 and the VIP role in Discord. Do not invent prices or VIP perks beyond this.
Payments: for payment problems send users to /payment. Never claim a payment was verified or a role was granted. Staff do not hold funds or guarantee deals. Warn users to verify identities, agree on deliverables first, and never share passwords, tokens, or recovery codes.
Only help with scripts and files the user has the rights to use. Do not help break protections on someone else's paid or private content, and say so briefly when it applies.
If you are not sure about something specific to this community, say so and point to @magmafox63911.`;

// Simple per-instance rate limit (resets on cold start). Good enough to stop casual abuse;
// for production use a shared store such as Upstash Redis.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  const clean = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-16)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!clean.length || clean[clean.length - 1].role !== "user") {
    return res.status(400).json({ error: "Send at least one user message." });
  }

  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.SITE_URL || "https://elite-uncopylocked.vercel.app",
        "X-Title": "Elite Uncopylocked",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openrouter/auto",
        messages: [{ role: "system", content: SYSTEM }, ...clean],
        max_tokens: 800,
      }),
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("OpenRouter error", upstream.status, data?.error?.message);
      return res.status(502).json({ error: "The assistant is unavailable right now." });
    }
    const text = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ text: text.trim() });
  } catch (err) {
    console.error("chat route failed", err);
    return res.status(500).json({ error: "The assistant is unavailable right now." });
  }
}
