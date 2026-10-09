/**
 * WhatsApp Handler — Receives webhook events from Meta Cloud API.
 *
 * Option A (implemented here): Shared Platform Number
 *   - maavaDao registers ONE WhatsApp Business number via Meta Cloud API
 *   - All users message this number
 *   - Routing: phone_number → platform_channel_links → user's maava instance
 *
 * Option B (future): Embedded Signup — each user brings their own number
 */
const { Router } = require('express');
const config = require('./config');
const { findUserByPlatformId, routeMessage } = require('./router');

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a text message via WhatsApp Cloud API */
async function sendWhatsAppMessage(to, text) {
  // WhatsApp Cloud API has a 4096-char limit
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await fetch(
      `https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.whatsapp.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: chunk },
        }),
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook verification (GET) — Meta sends this on setup
// ---------------------------------------------------------------------------

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[whatsapp] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// Webhook endpoint (POST) — receives message events from Meta
// ---------------------------------------------------------------------------

router.post('/webhook', async (req, res) => {
  // Always respond 200 quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return; // Not a message event

    for (const msg of value.messages) {
      if (msg.type !== 'text') continue; // Only handle text messages for now

      const from = msg.from; // Phone number e.g. "994501234567"
      const text = msg.text?.body;
      if (!from || !text) continue;

      // Look up user
      const user = await findUserByPlatformId('whatsapp', from);
      if (!user) {
        await sendWhatsAppMessage(
          from,
          `Welcome to maavaDao! 🤖\n\n` +
          `I don't recognize your phone number yet.\n` +
          `Please link it at: ${config.dashboardBaseUrl}/channels/whatsapp`,
        );
        continue;
      }

      // Route to maava
      const reply = await routeMessage(user.runtimeEndpoint, user.gatewayToken, text);
      await sendWhatsAppMessage(from, reply);
    }
  } catch (err) {
    console.error('[whatsapp] Error handling webhook:', err);
  }
});

module.exports = { whatsappRouter: router, sendWhatsAppMessage };
