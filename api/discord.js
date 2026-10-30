// Vercel serverless function: GET /api/discord
// Returns live public stats for the Discord invite. No bot token needed.
const CODE = "2D4KTvA9Sh";
const TTL = 5 * 60 * 1000;
let cache = { t: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (cache.data && Date.now() - cache.t < TTL) return res.status(200).json(cache.data);
  try {
    const r = await fetch(`https://discord.com/api/v10/invites/${CODE}?with_counts=true`, { headers: { Accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: "Discord unavailable" });
    const j = await r.json();
    const g = j.guild || {};
    const data = {
      name: g.name || "Elite Uncopylocked",
      desc: g.description || null,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
      members: j.approximate_member_count ?? null,
      online: j.approximate_presence_count ?? null,
    };
    cache = { t: Date.now(), data };
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ error: "Discord unavailable" });
  }
}
