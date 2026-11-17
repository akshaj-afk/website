// Discord REST helpers shared by api/community.js and api/discord-interactions.js.
// Everything here uses the bot token from DISCORD_BOT_TOKEN. The token is never logged.
export const DISCORD_API = "https://discord.com/api/v10";

// Permission bits from Discord's permissions documentation.
export const PERM = { ADMINISTRATOR: 8, MANAGE_CHANNELS: 16, VIEW: 1024, SEND: 2048, HISTORY: 65536 };
const TICKET_USER_ALLOW = String(PERM.VIEW | PERM.SEND | PERM.HISTORY);
const SNOWFLAKE = /^\d{17,20}$/;

export class DiscordError extends Error {
  constructor(status, code, message, where) {
    super(`Discord ${status}${code ? ` (code ${code})` : ""} on ${where}: ${message}`);
    this.name = "DiscordError";
    this.status = status;
    this.code = code ?? null;
  }
}

// One place for every Discord REST call. Throws DiscordError with Discord's own code and message.
export async function discordApi(method, path, body) {
  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  const r = await fetch(DISCORD_API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new DiscordError(r.status, data.code, data.message || "request failed", `${method} ${path.split("?")[0]}`);
  }
  return data;
}

// Validates the ticket settings and returns a list of problems (empty when everything is usable).
export function ticketConfig() {
  const values = {
    DISCORD_BOT_TOKEN: (process.env.DISCORD_BOT_TOKEN || "").trim(),
    DISCORD_GUILD_ID: (process.env.DISCORD_GUILD_ID || "").trim(),
    TICKET_CATEGORY_ID: (process.env.TICKET_CATEGORY_ID || "").trim(),
    SUPPORT_ROLE_ID: (process.env.SUPPORT_ROLE_ID || "").trim(),
  };
  const problems = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) problems.push(`${name} is missing`);
    else if (name !== "DISCORD_BOT_TOKEN" && !SNOWFLAKE.test(value)) problems.push(`${name} must be a numeric Discord ID (not a name or invite code)`);
  }
  return {
    problems,
    guild: values.DISCORD_GUILD_ID,
    category: values.TICKET_CATEGORY_ID,
    staffRole: values.SUPPORT_ROLE_ID,
  };
}

// The bot's own user ID is needed so the bot can be given access to the channels it creates.
let botId = null;
export async function botUserId() {
  if (!botId) botId = (await discordApi("GET", "/users/@me")).id;
  return botId;
}

// Turns a Discord error into a sentence staff and users can act on.
export function friendlyDiscordError(e) {
  const code = e && e.code;
  if (code === 50013) return "The Discord bot is missing permissions. It needs View Channel, Send Messages, Read Message History and Manage Channels in the ticket category.";
  if (code === 50001) return "The Discord bot cannot access the ticket channel.";
  if (code === 10003 || code === 10004 || code === 10011) return "A Discord ID in the server settings is wrong. Check DISCORD_GUILD_ID, TICKET_CATEGORY_ID and SUPPORT_ROLE_ID.";
  if (e && e.status) return `Discord rejected the ticket (HTTP ${e.status}). The site logs have the details.`;
  return "Couldn't reach Discord to open the ticket. Please try again in a moment.";
}

const clip = (s, n) => String(s ?? "").slice(0, n) || "—";
const TICKET_COLOR = 0x3498db;

// Builds the embed from the database row, so the message always matches what is stored.
export function buildTicketEmbed(t) {
  const status = t.status === "closed"
    ? "Closed"
    : t.claimed_by ? `Claimed by ${t.claimed_by}` : "Open, not claimed yet";
  return {
    title: "📥 File Request",
    color: TICKET_COLOR,
    fields: [
      { name: "Title", value: clip(t.title, 1024), inline: false },
      { name: "Category", value: clip(t.cat, 1024), inline: true },
      { name: "Budget", value: clip(t.budget || "Not given", 1024), inline: true },
      { name: "Details", value: clip(t.description, 1024), inline: false },
      { name: "Requested by", value: `<@${t.requester_id}>`, inline: true },
      { name: "Status", value: status, inline: true },
    ],
    footer: { text: `Request #${t.id} · Requested on the website` },
  };
}

// Claim, Unclaim and Close buttons. custom_id is "ticket:<action>:<requestId>".
export function ticketComponents(requestId, { claimed, closed }) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Claim", custom_id: `ticket:claim:${requestId}`, disabled: closed || claimed },
      { type: 2, style: 2, label: "Unclaim", custom_id: `ticket:unclaim:${requestId}`, disabled: closed || !claimed },
      { type: 2, style: 4, label: "Close", custom_id: `ticket:close:${requestId}`, disabled: closed },
    ],
  }];
}

// Deletes a channel we created but could not finish setting up. Never throws.
export async function deleteChannelQuietly(channelId, requestId) {
  try {
    await discordApi("DELETE", `/channels/${channelId}`);
    console.warn(`[ticket] removed incomplete channel for request #${requestId}`);
  } catch (e) {
    console.error(`[ticket] could not remove incomplete channel for request #${requestId}:`, e.message);
  }
}

// Removes the requester's access when a ticket is closed. Staff keep access for the record.
export async function removeRequesterAccess(channelId, requesterId) {
  try {
    await discordApi("DELETE", `/channels/${channelId}/permissions/${requesterId}`);
  } catch (e) {
    console.error("[ticket] could not remove requester access:", e.message);
  }
}

// Creates the private ticket channel and posts the ticket message.
// If the message cannot be posted, the new channel is deleted so no empty ticket is left behind.
export async function createTicketChannel({ cfg, ticket }) {
  const who = String(ticket.requester || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "member";
  const self = await botUserId();
  const channel = await discordApi("POST", `/guilds/${cfg.guild}/channels`, {
    name: `request-${who}-${ticket.id}`,
    type: 0,
    parent_id: cfg.category,
    topic: `File request #${ticket.id}`,
    permission_overwrites: [
      { id: cfg.guild, type: 0, deny: String(PERM.VIEW) },            // hidden from @everyone
      { id: ticket.requester_id, type: 1, allow: TICKET_USER_ALLOW },   // the requester
      { id: cfg.staffRole, type: 0, allow: TICKET_USER_ALLOW },         // support staff
      { id: self, type: 1, allow: TICKET_USER_ALLOW },                  // the bot itself
    ],
  });

  try {
    const msg = await discordApi("POST", `/channels/${channel.id}/messages`, {
      content: `<@&${cfg.staffRole}> New file request from <@${ticket.requester_id}>!`,
      allowed_mentions: { roles: [cfg.staffRole], users: [ticket.requester_id] },
      embeds: [buildTicketEmbed(ticket)],
      components: ticketComponents(ticket.id, { claimed: false, closed: false }),
    });
    return {
      id: channel.id,
      messageId: msg.id,
      url: `https://discord.com/channels/${cfg.guild}/${channel.id}`,
    };
  } catch (e) {
    await deleteChannelQuietly(channel.id, ticket.id);
    throw e;
  }
}
