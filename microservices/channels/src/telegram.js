/**
 * Telegram Handler — Receives webhook updates from Telegram Bot API,
 * routes messages to the user's maava instance, and sends replies.
 *
 * maavaDao owns ONE bot (@MaavadaoBot). All users talk to it.
 * Routing: telegram_user_id → telegram_channel_links → user's maava URL → reply.
 *
 * Account linking:
 *   1. Deep-link: Dashboard generates token → t.me/maavadao_bot?start=TOKEN → bot validates → link.
 *   2. Login Widget: Dashboard embeds Telegram Login Widget → frontend verifies hash → link.
 *
 * Features:
 *   - update_id deduplication (in-memory LRU + DB)
 *   - Per-user sliding-window rate limiting
 *   - Full message logging (inbound + outbound) to telegram_message_logs
 *   - last_seen_at tracking
 *   - callback_query support
 *   - Structured logging
 */
const { Router } = require('express');
const crypto = require('crypto');
const config = require('./config');
const pool = require('./db');
const tgApi = require('./telegram-api');
const tgStore = require('./telegram-store');
const { routeMessage, clearHistory, newSession, listInstalledAgents, getSelectedAgent, setSelectedAgent } = require('./router');

const router = Router();

// Re-export sendMessage for backward compatibility (outbound.js imports it)
const sendTelegramMessage = tgApi.sendMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate secret_token header from Telegram webhook */
function validateWebhookSecret(req) {
  if (!config.telegram.webhookSecret) return true; // no secret configured
  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header) return false;
  return crypto.timingSafeEqual(
    Buffer.from(header),
    Buffer.from(config.telegram.webhookSecret),
  );
}

/** Send a reply and log it as outbound */
async function sendAndLog(chatId, text, user, telegramUserId) {
  try {
    const results = await tgApi.sendMessage(chatId, text);
    const msgId = results[0]?.message_id || null;
    await tgStore.logMessage({
      maavadaoUserId: user?.userId || null,
      telegramUserId,
      chatId,
      direction: 'outbound',
      text: text.slice(0, 10000),
      messageId: msgId,
      status: 'sent',
    });
    return results;
  } catch (err) {
    await tgStore.logMessage({
      maavadaoUserId: user?.userId || null,
      telegramUserId,
      chatId,
      direction: 'outbound',
      text: text.slice(0, 10000),
      status: 'failed',
      error: err.message,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Deep-link token handler — validates token & finalizes account link
// ---------------------------------------------------------------------------

async function handleLinkToken(chatId, telegramUserId, fromUser, token) {
  console.log(`[telegram] handleLinkToken — chatId=${chatId}, tgUser=${telegramUserId}, token=${token.slice(0, 6)}...`);
  try {
    // 1. Look up the token — must be unused and not expired
    const tokenResult = await pool.query(
      `SELECT token, user_id, platform, expires_at, used_at
       FROM platform_link_tokens
       WHERE token = $1 AND platform = 'telegram'
         AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [token],
    );

    if (!tokenResult.rows[0]) {
      const debugResult = await pool.query(
        `SELECT token, user_id, expires_at, used_at FROM platform_link_tokens WHERE token = $1`,
        [token],
      );
      if (debugResult.rows[0]) {
        const r = debugResult.rows[0];
        console.log(`[telegram] Token invalid — expires_at=${r.expires_at}, used_at=${r.used_at}`);
      } else {
        console.log(`[telegram] Token not found in DB`);
      }

      await sendAndLog(
        chatId,
        `This link has expired or was already used.\n\nGo back to your maavaDao dashboard and click "Link Telegram" again to generate a new one.`,
        null,
        telegramUserId,
      );
      return;
    }

    const { user_id: userId } = tokenResult.rows[0];
    console.log(`[telegram] Token valid — maps to user_id=${userId}`);

    // 2. Create link via telegram-store (handles both tables)
    await tgStore.linkTelegramUser(userId, {
      telegramUserId,
      chatId,
      username: fromUser.username || null,
      firstName: fromUser.first_name || null,
      lastName: fromUser.last_name || null,
    }, 'deep_link');

    // 3. Mark the token as used
    await pool.query(
      `UPDATE platform_link_tokens SET used_at = NOW() WHERE token = $1`,
      [token],
    );

    const name = fromUser.first_name || 'there';
    await sendAndLog(
      chatId,
      `✅ *Account linked!*\n\nHey ${name}, your Telegram is now connected to maavaDao.\nJust send me a message and I'll route it to your AI agent.`,
      { userId },
      telegramUserId,
    );

    console.log(`[telegram] ✅ Linked user ${userId} ← telegram ${telegramUserId}`);
  } catch (err) {
    console.error('[telegram] ❌ handleLinkToken error:', err.message, err.stack);
    try {
      await sendAndLog(
        chatId,
        `Something went wrong while linking your account. Please try again from your dashboard.`,
        null,
        telegramUserId,
      );
    } catch (sendErr) {
      console.error('[telegram] Failed to send error message:', sendErr.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook endpoint — receives updates from Telegram
// ---------------------------------------------------------------------------

router.post('/webhook', async (req, res) => {
  // Validate secret token
  if (!validateWebhookSecret(req)) {
    return res.sendStatus(403);
  }

  // Always respond 200 quickly to avoid Telegram retries
  res.sendStatus(200);

  try {
    const update = req.body;
    const updateId = update.update_id;

    // ── Deduplication guard ──
    if (updateId && await tgStore.isDuplicateUpdate(updateId)) {
      console.log(`[telegram] Duplicate update_id=${updateId}, skipping`);
      return;
    }
    tgStore.markUpdateProcessed(updateId);

    // ── Handle callback_query (inline keyboard button presses) ──
    if (update.callback_query) {
      const cbq = update.callback_query;
      const chatId = cbq.message?.chat?.id;
      const telegramUserId = String(cbq.from.id);
      const data = cbq.data || '';

      console.log(`[telegram] Callback query from ${telegramUserId}: "${data}"`);

      // Log inbound
      await tgStore.logMessage({
        updateId,
        telegramUserId,
        chatId,
        direction: 'inbound',
        text: `[callback_query] ${data}`,
        status: 'delivered',
        metadata: { type: 'callback_query', data },
      });

      // Acknowledge the callback
      await tgApi.answerCallbackQuery(cbq.id);

      // Handle known callback data patterns
      if (data.startsWith('agent:')) {
        const agentId = data.slice('agent:'.length);
        if (agentId === 'default') {
          setSelectedAgent('telegram', telegramUserId, null);
          newSession('telegram', telegramUserId);
          await sendAndLog(chatId, `✅ Switched to *default assistant*. New session started.`, null, telegramUserId);
        } else {
          setSelectedAgent('telegram', telegramUserId, agentId);
          newSession('telegram', telegramUserId);
          await sendAndLog(chatId, `✅ Agent selected. New session started — send a message to begin!`, null, telegramUserId);
        }
      }
      return;
    }

    // ── Handle text messages ──
    const message = update.message || update.edited_message;
    if (!message || !message.text) return; // ignore non-text updates

    const telegramUserId = String(message.from.id);
    const chatId = message.chat.id;
    const text = message.text.trim();

    console.log(`[telegram] Incoming from ${telegramUserId}: "${text.slice(0, 100)}"`);

    // ── Rate limiting ──
    if (tgStore.isRateLimited(telegramUserId)) {
      console.log(`[telegram] Rate limited: ${telegramUserId}`);
      await tgStore.logMessage({
        updateId,
        telegramUserId,
        chatId,
        direction: 'inbound',
        text,
        status: 'rate_limited',
      });
      await tgApi.sendMessage(chatId, `⏳ You're sending messages too fast. Please wait a moment.`);
      return;
    }

    // ── Log inbound message ──
    await tgStore.logMessage({
      updateId,
      telegramUserId,
      chatId,
      direction: 'inbound',
      text,
      messageId: message.message_id,
      status: 'delivered',
      metadata: {
        username: message.from.username,
        firstName: message.from.first_name,
        isEdited: !!update.edited_message,
      },
    });

    // ── Update last_seen_at (fire and forget) ──
    tgStore.updateLastSeen(telegramUserId);

    // Handle /start with optional deep-link token
    if (text === '/start' || text.startsWith('/start ')) {
      const payload = text.slice('/start '.length).trim();

      if (payload) {
        await handleLinkToken(chatId, telegramUserId, message.from, payload);
      } else {
        await sendAndLog(
          chatId,
          `Welcome to *maavaDao*! 🤖\n\n` +
          `To connect this Telegram account to your maava, ` +
          `go to your dashboard and open *Channels → Telegram*, then click "Link Telegram".\n\n` +
          `Once linked, just message me and I'll route it to your AI assistant.`,
          null,
          telegramUserId,
        );
      }
      return;
    }

    // Handle /new — start a new conversation session (keeps agent selection)
    if (text === '/new') {
      newSession('telegram', telegramUserId);
      const agentId = getSelectedAgent('telegram', telegramUserId);
      let msg = `🆕 New session started! Previous conversation context cleared.`;
      if (agentId) {
        const user = await tgStore.findTelegramUser(telegramUserId);
        if (user) {
          const agents = await listInstalledAgents(user.userId);
          const active = agents.find((a) => a.id === agentId);
          if (active) msg += `\nStill talking to *${active.name}*.`;
        }
      }
      msg += `\nJust send a message to begin.`;
      await sendAndLog(chatId, msg, null, telegramUserId);
      return;
    }

    // Handle /clear — reset everything (history + agent selection)
    if (text === '/clear' || text === '/reset') {
      clearHistory('telegram', telegramUserId);
      setSelectedAgent('telegram', telegramUserId, null);
      await sendAndLog(chatId, `🗑️ Session cleared — history and agent selection reset. Start fresh!`, null, telegramUserId);
      return;
    }

    // Handle /unlink — self-service account unlinking
    if (text === '/unlink') {
      const user = await tgStore.findTelegramUser(telegramUserId);
      if (!user) {
        await sendAndLog(chatId, `Your Telegram is not linked to any maavaDao account.`, null, telegramUserId);
        return;
      }
      await tgStore.unlinkTelegramUser(telegramUserId);
      clearHistory('telegram', telegramUserId);
      setSelectedAgent('telegram', telegramUserId, null);
      await sendAndLog(
        chatId,
        `✅ Your Telegram account has been unlinked from maavaDao.\n\nYou can re-link anytime from your dashboard → Channels → Telegram.`,
        user,
        telegramUserId,
      );
      return;
    }

    // Handle /agents — list installed agents
    if (text === '/agents') {
      const user = await tgStore.findTelegramUser(telegramUserId);
      if (!user) {
        await sendAndLog(chatId, `Link your account first — go to your maavaDao dashboard → Channels → Telegram.`, null, telegramUserId);
        return;
      }

      const agents = await listInstalledAgents(user.userId);
      const currentAgentId = getSelectedAgent('telegram', telegramUserId);

      if (!agents.length) {
        await sendAndLog(
          chatId,
          `You don't have any agents installed yet.\n\n` +
          `Go to your maavaDao dashboard → *Agent Marketplace* to install agents.\n` +
          `Without an agent selected, I'll use the default assistant.`,
          user,
          telegramUserId,
        );
        return;
      }

      let msg = `*Your Agents*\n\n`;
      agents.forEach((a, i) => {
        const selected = a.id === currentAgentId ? ' ✅' : '';
        const desc = a.short_description ? ` — ${a.short_description}` : '';
        msg += `${i + 1}. *${a.name}*${desc}${selected}\n`;
      });
      msg += `\nUse /agent <number> to switch.\nUse /agent 0 to use the default assistant.`;
      await sendAndLog(chatId, msg, user, telegramUserId);
      return;
    }

    // Handle /agent <number or name> — select an agent
    if (text.startsWith('/agent ') || text === '/agent') {
      if (text === '/agent') {
        const agentId = getSelectedAgent('telegram', telegramUserId);
        if (!agentId) {
          await sendAndLog(chatId, `Currently using the *default assistant*.\nUse /agents to see available agents.`, null, telegramUserId);
        } else {
          const user = await tgStore.findTelegramUser(telegramUserId);
          if (user) {
            const agents = await listInstalledAgents(user.userId);
            const active = agents.find((a) => a.id === agentId);
            await sendAndLog(chatId, `Currently talking to *${active ? active.name : 'Unknown'}*.\nUse /agents to see all agents.`, user, telegramUserId);
          }
        }
        return;
      }

      const arg = text.slice('/agent '.length).trim();
      const user = await tgStore.findTelegramUser(telegramUserId);
      if (!user) {
        await sendAndLog(chatId, `Link your account first.`, null, telegramUserId);
        return;
      }

      if (arg === '0' || arg.toLowerCase() === 'default') {
        setSelectedAgent('telegram', telegramUserId, null);
        newSession('telegram', telegramUserId);
        await sendAndLog(chatId, `✅ Switched to *default assistant*. New session started.`, user, telegramUserId);
        return;
      }

      const agents = await listInstalledAgents(user.userId);
      if (!agents.length) {
        await sendAndLog(chatId, `You have no agents installed. Visit the *Agent Marketplace* in your dashboard.`, user, telegramUserId);
        return;
      }

      const num = parseInt(arg, 10);
      let selected = null;
      if (!isNaN(num) && num >= 1 && num <= agents.length) {
        selected = agents[num - 1];
      } else {
        const lower = arg.toLowerCase();
        selected = agents.find(
          (a) => a.name.toLowerCase() === lower || a.slug === lower,
        ) || agents.find(
          (a) => a.name.toLowerCase().includes(lower),
        );
      }

      if (!selected) {
        await sendAndLog(chatId, `Agent not found. Use /agents to see the list, then /agent <number>.`, user, telegramUserId);
        return;
      }

      setSelectedAgent('telegram', telegramUserId, selected.id);
      newSession('telegram', telegramUserId);
      const desc = selected.short_description ? `\n${selected.short_description}` : '';
      await sendAndLog(chatId, `✅ Now talking to *${selected.name}*${desc}\n\nNew session started — send a message to begin!`, user, telegramUserId);
      return;
    }

    // Handle /help
    if (text === '/help') {
      await sendAndLog(
        chatId,
        `*maavaDao Bot Commands*\n\n` +
        `/new — Start a new conversation session\n` +
        `/agents — List your installed AI agents\n` +
        `/agent <#> — Switch to a different agent\n` +
        `/agent 0 — Switch back to default assistant\n` +
        `/clear — Reset everything (history + agent)\n` +
        `/unlink — Disconnect this Telegram from maavaDao\n` +
        `/help — Show this help message\n\n` +
        `Just type any message and I'll route it to your AI agent!`,
        null,
        telegramUserId,
      );
      return;
    }

    // Look up linked user (uses telegram_channel_links with fallback)
    const user = await tgStore.findTelegramUser(telegramUserId);
    if (!user) {
      await sendAndLog(
        chatId,
        `I don't recognize your Telegram account yet.\n\n` +
        `Go to your maavaDao dashboard → *Channels → Telegram* and click "Link Telegram" to connect.`,
        null,
        telegramUserId,
      );
      return;
    }

    // Show typing indicator while the AI processes
    tgApi.sendChatAction(chatId);

    // Keep typing indicator alive during long responses (re-send every 4s)
    const typingInterval = setInterval(() => tgApi.sendChatAction(chatId), 4000);

    try {
      // Route through platform dashboard API (handles AI, agents, persistence)
      console.log(`[telegram] Routing via platform API for user ${user.userId} (dashboard: ${config.dashboardBaseUrl})`);
      const reply = await routeMessage(
        user,
        text,
        'telegram',
        telegramUserId,
      );
      clearInterval(typingInterval);
      await sendAndLog(chatId, reply, user, telegramUserId);
      console.log(`[telegram] ✅ Reply sent to ${telegramUserId} (${reply.length} chars)`);
    } catch (routeErr) {
      clearInterval(typingInterval);
      const status = routeErr.status || routeErr.statusCode;
      const errDetail = routeErr.message || String(routeErr);
      console.error(`[telegram] ❌ Route failed for ${telegramUserId}: status=${status} msg=${errDetail}`, routeErr.stack);

      let errorMsg;
      if (routeErr.message?.includes('timeout') || routeErr.name === 'TimeoutError' || routeErr.name === 'AbortError') {
        errorMsg = `⏳ Your AI agent is taking too long to respond. It might be waking up — please try again in a moment.`;
      } else if (status === 401 || status === 403) {
        errorMsg = `🔑 Authentication error with your AI agent. Please re-link your account from the dashboard.`;
      } else if (status === 502 || status === 503 || status === 504) {
        errorMsg = `🔧 Your AI agent is temporarily unavailable. Please try again in a moment.`;
      } else if (status === 404) {
        errorMsg = `🔧 AI endpoint not found — the dashboard URL may be misconfigured. Contact support.`;
      } else if (status >= 400 && status < 500) {
        errorMsg = `⚠️ Request error (${status}). Please try again or re-link your account.`;
      } else if (status >= 500) {
        errorMsg = `🔧 Server error on the AI backend (${status}). Please try again shortly.`;
      } else {
        // Network error or unknown — include detail for debugging
        const short = errDetail.length > 120 ? errDetail.slice(0, 120) + '…' : errDetail;
        errorMsg = `⚠️ Could not reach your AI agent: ${short}`;
      }
      await sendAndLog(chatId, errorMsg, user, telegramUserId);
    }
  } catch (err) {
    console.error('[telegram] Unhandled error in webhook:', err);
  }
});

// ---------------------------------------------------------------------------
// Setup: register webhook URL with Telegram
// ---------------------------------------------------------------------------

async function setupTelegramWebhook() {
  if (!config.telegram.botToken) {
    console.warn('[telegram] No TELEGRAM_BOT_TOKEN set — skipping webhook setup');
    return;
  }

  const webhookUrl = config.telegram.webhookBaseUrl
    ? `${config.telegram.webhookBaseUrl}${config.telegram.webhookPath || '/telegram/webhook'}`
    : `${config.publicBaseUrl}/telegram/webhook`;

  try {
    const result = await tgApi.setWebhook(webhookUrl);
    console.log(`[telegram] Webhook set to ${webhookUrl}`, result);
  } catch (err) {
    console.error('[telegram] Failed to set webhook:', err.message);
  }
}

module.exports = { telegramRouter: router, setupTelegramWebhook, sendTelegramMessage };
