// Discord bot: /proof <text>
// Members type this in the server after ordering VIP on the website.
// Assumes discord.js v14 and the same lib/db.js helpers the website uses.
//
// Register the command with one required string option named "text" (max 300 chars).
// Run this once in your database first, if the column does not exist yet:
//   ALTER TABLE vip_orders ADD COLUMN IF NOT EXISTS proof TEXT;

import { ensureSchema, sql, clean, notify } from "../lib/db.js";

export const proofCommand = {
  name: "proof",
  description: "Send your VIP payment proof (transaction ID or receipt link)",
  options: [
    { name: "text", description: "Your PayPal transaction ID or a link to your receipt", type: 3, required: true, max_length: 300 },
  ],
};

export async function handleProof(interaction) {
  const reply = (content) => interaction.reply({ content, ephemeral: true });

  try {
    await ensureSchema();
  } catch {
    return reply("The database is unavailable right now. If this keeps happening, DM @legend_demon_404 on Discord.");
  }

  const proof = clean(interaction.options.getString("text"), 300);
  if (proof.length < 6) {
    return reply("Send your PayPal transaction ID or a link to your receipt, for example: `/proof text: 1AB23456CD789012E`");
  }

  const discordId = String(interaction.user.id);
  const name = clean(interaction.user.username, 40);

  const [order] = await sql`SELECT id, method FROM vip_orders
                            WHERE discord_id = ${discordId} AND status = 'pending'
                            ORDER BY created_at DESC LIMIT 1`;
  if (!order) {
    return reply("You don't have a VIP order waiting for proof. Order VIP on the VIP page of the website first, then send /proof again.");
  }

  await sql`UPDATE vip_orders SET proof = ${proof} WHERE id = ${order.id}`;

  // The staff alert is non-fatal: the proof is already saved even if this fails.
  Promise.resolve()
    .then(() => notify(`🧾 VIP proof for order #${order.id} from ${name} (${discordId}) paid with ${order.method}: ${proof}\nStaff: check the payment, then approve the order on the website.`))
    .catch((e) => console.error("notify failed:", e));

  return reply("Thanks! Your proof was sent. Staff will check your payment and give you VIP.");
}
