// Discord interactions endpoint: handles the Claim, Unclaim and Close buttons on ticket messages.
// Set in the Discord Developer Portal (your bot application → General Information):
//   Interactions Endpoint URL = https://<your-site>/api/discord-interactions
// Requires DISCORD_PUBLIC_KEY from the same page. Discord checks the URL with a PING before saving it.
import { createPublicKey, verify } from "node:crypto";
import { ensureSchema, sql } from "../lib/db.js";
import { isAdmin } from "../lib/auth.js";
import { ticketConfig, buildTicketEmbed, ticketComponents, removeRequesterAccess } from "../lib/discord.js";

// Discord signs the raw request body, so the body must not be parsed before verification.
export const config = { api: { bodyParser: false } };

// ASN.1 prefix that turns a raw 32-byte Ed25519 public key into a DER SPKI key Node can use.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, timestamp) {
  const hex = (process.env.DISCORD_PUBLIC_KEY || "").trim();
  if (!hex || !signature || !timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(String(timestamp)), rawBody]), key, Buffer.from(String(signature), "hex"));
  } catch {
    return false;
  }
}

// Shown only to the person who clicked (flags 64 = ephemeral).
const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });

// Type 7 replaces the ticket message in place, so the embed and buttons always match the database.
const updateMessage = (t, state) => ({
  type: 7,
  data: { embeds: [buildTicketEmbed(t)], components: ticketComponents(t.id, state) },
});

async function handleButton(i) {
  const [ns, action, idStr] = String(i.data?.custom_id || "").split(":");
  const id = Number(idStr);
  if (ns !== "ticket" || !Number.isInteger(id)) return ephemeral("Unknown button.");

  await ensureSchema();
  const who = i.member?.user || i.user || {};
  const uid = String(who.id || "");
  const name = who.global_name || who.username || "staff";
  const staffRole = ticketConfig().staffRole;
  const isStaff = (i.member?.roles || []).includes(staffRole) || isAdmin(who);

  const [t] = await sql`SELECT * FROM requests WHERE id = ${id}`;
  if (!t) return ephemeral("This ticket no longer exists in the database.");

  if (action === "claim") {
    if (!isStaff) return ephemeral("Only support staff can claim tickets.");
    if (t.status !== "open") return ephemeral(`This ticket is ${t.status}.`);
    // Conditional update: if two staff click at once, only one row changes.
    const won = await sql`UPDATE requests SET claimed_by = ${name}, claimed_by_id = ${uid}
                          WHERE id = ${id} AND status = 'open' AND claimed_by_id IS NULL
                          RETURNING id`;
    if (!won.length) return ephemeral("Someone else has already claimed this ticket.");
    return updateMessage({ ...t, claimed_by: name, claimed_by_id: uid }, { claimed: true, closed: false });
  }

  if (action === "unclaim") {
    if (!t.claimed_by_id) return ephemeral("This ticket is not claimed.");
    const admin = isAdmin(who);
    if (t.claimed_by_id !== uid && !admin) return ephemeral(`Only ${t.claimed_by} can unclaim this ticket.`);
    if (t.status !== "open") return ephemeral(`This ticket is ${t.status}.`);
    await sql`UPDATE requests SET claimed_by = NULL, claimed_by_id = NULL WHERE id = ${id}`;
    return updateMessage({ ...t, claimed_by: null, claimed_by_id: null }, { claimed: false, closed: false });
  }

  if (action === "close") {
    if (!isStaff) return ephemeral("Only support staff can close tickets.");
    const closed = await sql`UPDATE requests SET status = 'closed', closed_at = NOW()
                             WHERE id = ${id} AND status = 'open' RETURNING id`;
    if (!closed.length) return ephemeral(`This ticket is already ${t.status}.`);
    // Lock the ticket for the requester. The channel stays up so staff keep the record.
    if (t.channel_id && t.requester_id) await removeRequesterAccess(t.channel_id, t.requester_id);
    return updateMessage({ ...t, status: "closed" }, { claimed: !!t.claimed_by_id, closed: true });
  }

  return ephemeral("Unknown button.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRaw(req);
  if (!verifySignature(raw, req.headers["x-signature-ed25519"], req.headers["x-signature-timestamp"])) {
    console.warn("[interactions] rejected a request with an invalid signature");
    return res.status(401).end("invalid request signature");
  }

  let interaction;
  try { interaction = JSON.parse(raw.toString("utf8")); }
  catch { return res.status(400).end(); }

  if (interaction.type === 1) return res.status(200).json({ type: 1 }); // PING from the Developer Portal
  if (interaction.type !== 3) return res.status(200).json(ephemeral("Unsupported interaction."));

  try {
    return res.status(200).json(await handleButton(interaction));
  } catch (e) {
    console.error("[interactions] button failed:", e && e.message ? e.message : e);
    return res.status(200).json(ephemeral("Something went wrong with that button. The site logs have the details; try again."));
  }
}
