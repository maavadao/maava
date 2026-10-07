/**
 * Outbound Delivery API — Receives delivery requests from tenant backends
 * (cron jobs, heartbeat, scheduled messages) and sends them to users
 * via their linked platform (Telegram, Discord, WhatsApp).
 *
 * POST /api/outbound/send
 *   Body: { user_id, platform?, text, secret }
 *   - user_id: UUID of the mawaDao user
 *   - platform: "telegram" | "discord" | "whatsapp" (optional — sends to all linked if omitted)
 *   - text: message content
 *   - secret: shared secret for authentication
 *
 * The tenant backend calls this when a cron job or heartbeat produces
 * output that should be delivered to the user's messaging channel.
 */
const { Router } = require('express');
const crypto = require('crypto');
const config = require('./config');
const { findChatIdByUserId } = require('./router');

const router = Router();

// Lazily loaded platform senders — avoids circular deps
let _sendTelegram;
function getSendTelegram() {
  if (!_sendTelegram) {
    _sendTelegram = require('./telegram').sendTelegramMessage;
  }
  return _sendTelegram;
}

let _sendDiscordDM;
function getSendDiscordDM() {
  if (!_sendDiscordDM) {
    _sendDiscordDM = require('./discord').sendDiscordDM;
  }
  return _sendDiscordDM;
}

let _sendWhatsApp;
function getSendWhatsApp() {
  if (!_sendWhatsApp) {
    _sendWhatsApp = require('./whatsapp').sendWhatsAppMessage;
  }
  return _sendWhatsApp;
}

/** Validate the shared secret */
function validateSecret(secret) {
  const expected = config.outboundSecret;
  if (!expected) return false; // must be configured
  if (!secret || typeof secret !== 'string') return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(secret),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/outbound/send — deliver a message to a user's linked channel
// ---------------------------------------------------------------------------
router.post('/send', async (req, res) => {
  const { user_id, platform, text, secret } = req.body || {};

  // Auth
  if (!validateSecret(secret)) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  // Validate required fields
  if (!user_id || !text) {
    return res.status(400).json({ error: 'user_id and text are required' });
  }

  // Determine which platforms to deliver to
  const platforms = platform ? [platform] : ['telegram', 'discord', 'whatsapp'];
  const results = [];

  for (const p of platforms) {
    try {
      const link = await findChatIdByUserId(user_id, p);
      if (!link) {
        results.push({ platform: p, status: 'skipped', reason: 'not linked' });
        continue;
      }

      if (p === 'telegram') {
        await getSendTelegram()(link.chatId, text);
        results.push({ platform: p, status: 'sent', chatId: link.chatId });
      } else if (p === 'discord') {
        await getSendDiscordDM()(link.chatId, text);
        results.push({ platform: p, status: 'sent', chatId: link.chatId });
      } else if (p === 'whatsapp') {
        await getSendWhatsApp()(link.chatId, text);
        results.push({ platform: p, status: 'sent', chatId: link.chatId });
      } else {
        results.push({ platform: p, status: 'skipped', reason: 'unsupported platform' });
      }
    } catch (err) {
      console.error(`[outbound] Failed to deliver to ${p} for user ${user_id}:`, err.message);
      results.push({ platform: p, status: 'error', error: err.message });
    }
  }

  const delivered = results.filter((r) => r.status === 'sent').length;
  console.log(`[outbound] Delivered ${delivered}/${platforms.length} for user ${user_id}`);

  res.json({ ok: true, results });
});

// ---------------------------------------------------------------------------
// POST /api/outbound/broadcast — send to multiple users (admin only, future)
// ---------------------------------------------------------------------------

module.exports = { outboundRouter: router };
