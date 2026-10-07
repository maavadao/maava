/**
 * Message Router — Core routing logic.
 *
 * Given a platform + platform_user_id, finds the user's mawaDao account
 * and routes messages through the platform dashboard API.
 *
 * Manages per-user session state: conversation history, selected agent.
 */
const pool = require('./db');
const config = require('./config');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Per-user session state — keyed by `${platform}:${platformUserId}`
// Stores conversation history and selected agent.
// ---------------------------------------------------------------------------
const MAX_HISTORY_TURNS = 20;

/** @type {Map<string, { history: Array, agentId: string|null }>} */
const sessions = new Map();

function _key(platform, platformUserId) {
  return `${platform}:${platformUserId}`;
}

function _session(platform, platformUserId) {
  const key = _key(platform, platformUserId);
  if (!sessions.has(key)) {
    sessions.set(key, { history: [], agentId: null });
  }
  return sessions.get(key);
}

function getHistory(platform, platformUserId) {
  return _session(platform, platformUserId).history;
}

function appendHistory(platform, platformUserId, role, content) {
  const s = _session(platform, platformUserId);
  s.history.push({ role, content });
  if (s.history.length > MAX_HISTORY_TURNS) {
    s.history.splice(0, s.history.length - MAX_HISTORY_TURNS);
  }
}

/** Start a new session — clears history but keeps agent selection. */
function newSession(platform, platformUserId) {
  const s = _session(platform, platformUserId);
  s.history = [];
  // agentId is intentionally kept — "new session" doesn't mean "forget agent"
}

function clearHistory(platform, platformUserId) {
  newSession(platform, platformUserId);
}

function getSelectedAgent(platform, platformUserId) {
  return _session(platform, platformUserId).agentId;
}

function setSelectedAgent(platform, platformUserId, agentId) {
  _session(platform, platformUserId).agentId = agentId;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * Look up a mawaDao user by their platform identity.
 * For Telegram: uses telegram_channel_links first (with fallback).
 * For other platforms: uses generic platform_channel_links.
 * Returns user info needed for dashboard API routing, or null.
 */
async function findUserByPlatformId(platform, platformUserId) {
  // Telegram: delegate to telegram-store for dedicated table support
  if (platform === 'telegram') {
    try {
      const tgStore = require('./telegram-store');
      const user = await tgStore.findTelegramUser(platformUserId);
      if (user) return user;
    } catch {
      // If telegram-store fails, fall through to generic query
    }
  }

  const result = await pool.query(
    `SELECT
       pcl.user_id,
       pcl.platform_meta,
       u.email,
       t.subdomain,
       t.id           AS tenant_id
     FROM platform_channel_links pcl
     JOIN tenants t ON t.user_id = pcl.user_id AND t.status = 'active'
     JOIN users u ON u.id = pcl.user_id
     WHERE pcl.platform = $1
       AND pcl.platform_user_id = $2
       AND pcl.is_active = true
     LIMIT 1`,
    [platform, String(platformUserId)],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    userId: row.user_id,
    email: row.email,
    subdomain: row.subdomain || '',
    tenantId: row.tenant_id || '',
    platformMeta: row.platform_meta || {},
  };
}

/**
 * List installed agents for a user (from marketplace_agents).
 * Returns [{ id, name, slug, shortDescription, iconUrl }]
 */
async function listInstalledAgents(userId) {
  const result = await pool.query(
    `SELECT
       ma.id,
       ma.name,
       ma.slug,
       ma.short_description,
       ma.icon_url
     FROM user_installed_agents uia
     JOIN marketplace_agents ma ON ma.id = uia.agent_id
     WHERE uia.user_id = $1 AND uia.is_active = true
     ORDER BY uia.last_used_at DESC NULLS LAST, uia.installed_at DESC`,
    [String(userId)],
  );
  return result.rows;
}

/**
 * Resolve platform_user_id → chat_id for outbound delivery.
 * For Telegram: uses telegram_channel_links first (with fallback).
 * Returns { chatId, platformMeta } or null.
 */
async function findChatIdByUserId(userId, platform) {
  // Telegram: try dedicated table first
  if (platform === 'telegram') {
    try {
      const tgStore = require('./telegram-store');
      const tgLink = await tgStore.findTelegramChatByUserId(userId);
      if (tgLink) {
        return { chatId: tgLink.chatId, platformMeta: { username: tgLink.telegramUsername } };
      }
    } catch {
      // Fall through to generic query
    }
  }

  const result = await pool.query(
    `SELECT platform_user_id, platform_meta
     FROM platform_channel_links
     WHERE user_id = $1 AND platform = $2 AND is_active = true
     LIMIT 1`,
    [String(userId), platform],
  );
  if (!result.rows[0]) return null;
  return {
    chatId: result.rows[0].platform_user_id,
    platformMeta: result.rows[0].platform_meta || {},
  };
}

// ---------------------------------------------------------------------------
// Route a message through the platform dashboard API
// ---------------------------------------------------------------------------

/**
 * Route a message through the mawaDao dashboard API.
 * The dashboard handles AI provider selection, agent injection, DB persistence.
 * Channel-router is a thin adapter — no direct AI calls.
 */
async function routeMessage(user, messageText, platform, platformUserId) {
  // Build messages array with conversation history
  const history = getHistory(platform, platformUserId);
  const messages = [...history, { role: 'user', content: messageText }];
  const agentId = getSelectedAgent(platform, platformUserId);

  // Generate JWT for dashboard authentication
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET not configured on mawadao-agent-channels');
  }
  const token = jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      subdomain: user.subdomain || '',
      tenantId: user.tenantId || '',
    },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h', issuer: 'mawadao-auth', subject: user.userId },
  );

  const dashboardUrl = `${config.dashboardBaseUrl}/api/ai-chat`;
  const body = JSON.stringify({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    model: 'openclaw',
    ...(agentId ? { agentId } : {}),
  });

  console.log(`[router] Calling ${dashboardUrl} for user ${user.userId} (subdomain: ${user.subdomain || 'none'})`);

  // Retry with back-off for transient failures
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 90_000;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[router] Retry ${attempt}/${MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }

      const response = await fetch(dashboardUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = new Error(`Platform API ${response.status}: ${text.slice(0, 200)}`);
        err.status = response.status;
        // Don't retry client errors
        if (response.status >= 400 && response.status < 500) throw err;
        lastError = err;
        continue;
      }

      // Dashboard returns streaming text/plain — collect full response
      const reply = await response.text();
      if (!reply || !reply.trim()) throw new Error('Empty reply from platform');

      const cleanReply = reply.trim();

      // Append to conversation history
      appendHistory(platform, platformUserId, 'user', messageText);
      appendHistory(platform, platformUserId, 'assistant', cleanReply);

      console.log(`[router] ✅ Platform replied (${cleanReply.length} chars)`);
      return cleanReply;
    } catch (err) {
      lastError = err;
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt === MAX_RETRIES) throw err;
    }
  }

  throw lastError;
}

module.exports = {
  findUserByPlatformId,
  routeMessage,
  listInstalledAgents,
  findChatIdByUserId,
  getHistory,
  appendHistory,
  clearHistory,
  newSession,
  getSelectedAgent,
  setSelectedAgent,
};
