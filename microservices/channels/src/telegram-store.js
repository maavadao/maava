/**
 * Telegram Store — Database operations, deduplication, and rate limiting.
 *
 * Provides:
 * - CRUD for telegram_channel_links (dedicated Telegram link table)
 * - Message logging to telegram_message_logs
 * - In-memory LRU + DB deduplication by update_id
 * - In-memory sliding-window rate limiting per user
 * - last_seen_at tracking
 */
const pool = require('./db');
const config = require('./config');

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

/** LRU set for recent update_ids — avoids a DB round-trip on every webhook */
const DEDUP_CACHE_MAX = 5000;
const recentUpdateIds = new Set();
const updateIdOrder = [];

/** Sliding-window rate limit — Map<telegramUserId, number[]> of timestamps */
const rateLimitWindows = new Map();
const RATE_LIMIT_PER_MINUTE = config.telegram.rateLimitPerMinute || 30;

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Check if a Telegram update_id has already been processed.
 * Uses an in-memory LRU cache first, then DB fallback.
 *
 * @param {number} updateId
 * @returns {Promise<boolean>} true if duplicate (already processed)
 */
async function isDuplicateUpdate(updateId) {
  if (!updateId) return false;

  // Check in-memory cache first (fast path)
  if (recentUpdateIds.has(updateId)) {
    return true;
  }

  // Check DB
  try {
    const result = await pool.query(
      `SELECT 1 FROM telegram_message_logs
       WHERE telegram_update_id = $1 LIMIT 1`,
      [updateId],
    );
    if (result.rows.length > 0) {
      // Add to in-memory cache for future fast lookups
      _addToCache(updateId);
      return true;
    }
  } catch (err) {
    // DB check failed — log but don't block processing
    console.error('[telegram-store] isDuplicateUpdate DB check failed:', err.message);
  }

  return false;
}

/**
 * Mark an update_id as processed (add to in-memory cache).
 * The DB entry is created by logMessage(), so this is only for the LRU cache.
 */
function markUpdateProcessed(updateId) {
  if (updateId) _addToCache(updateId);
}

function _addToCache(updateId) {
  if (recentUpdateIds.has(updateId)) return;
  recentUpdateIds.add(updateId);
  updateIdOrder.push(updateId);
  // Evict oldest if cache is full
  while (updateIdOrder.length > DEDUP_CACHE_MAX) {
    const oldest = updateIdOrder.shift();
    recentUpdateIds.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Rate Limiting — sliding window per telegram_user_id
// ---------------------------------------------------------------------------

/**
 * Check if a user is rate-limited.
 * @param {string|number} telegramUserId
 * @returns {boolean} true if rate limited (should reject)
 */
function isRateLimited(telegramUserId) {
  const key = String(telegramUserId);
  const now = Date.now();
  const windowStart = now - 60_000; // 1-minute window

  let timestamps = rateLimitWindows.get(key);
  if (!timestamps) {
    timestamps = [];
    rateLimitWindows.set(key, timestamps);
  }

  // Remove expired timestamps
  while (timestamps.length > 0 && timestamps[0] < windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT_PER_MINUTE) {
    return true;
  }

  timestamps.push(now);
  return false;
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, ts] of rateLimitWindows) {
    if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
      rateLimitWindows.delete(key);
    }
  }
}, 300_000);

// ---------------------------------------------------------------------------
// Database operations — telegram_channel_links
// ---------------------------------------------------------------------------

/**
 * Find a mawaDao user by their Telegram user ID.
 * Queries telegram_channel_links first, falls back to platform_channel_links.
 *
 * @param {string|number} telegramUserId
 * @returns {Promise<object|null>} { userId, email, subdomain, tenantId, telegramUsername, ... }
 */
async function findTelegramUser(telegramUserId) {
  // Primary: dedicated telegram_channel_links table
  try {
    const result = await pool.query(
      `SELECT
         tcl.mawadao_user_id AS user_id,
         tcl.telegram_user_id,
         tcl.telegram_chat_id,
         tcl.telegram_username,
         tcl.telegram_first_name,
         tcl.telegram_last_name,
         tcl.linked_via,
         tcl.last_seen_at,
         u.email,
         t.subdomain,
         t.id AS tenant_id
       FROM telegram_channel_links tcl
       JOIN users u ON u.id = tcl.mawadao_user_id
       JOIN tenants t ON t.user_id = tcl.mawadao_user_id AND t.status = 'active'
       WHERE tcl.telegram_user_id = $1
         AND tcl.is_active = true
       LIMIT 1`,
      [BigInt(telegramUserId)],
    );

    if (result.rows[0]) {
      const row = result.rows[0];
      return {
        userId: row.user_id,
        email: row.email,
        subdomain: row.subdomain || '',
        tenantId: row.tenant_id || '',
        telegramUsername: row.telegram_username,
        telegramFirstName: row.telegram_first_name,
        telegramChatId: row.telegram_chat_id,
        linkedVia: row.linked_via,
        lastSeenAt: row.last_seen_at,
      };
    }
  } catch (err) {
    // If telegram_channel_links doesn't exist yet (migration not run), fall through
    if (err.code !== '42P01') { // 42P01 = undefined_table
      console.error('[telegram-store] findTelegramUser query error:', err.message);
    }
  }

  // Fallback: generic platform_channel_links table
  const fallback = await pool.query(
    `SELECT
       pcl.user_id,
       pcl.platform_meta,
       u.email,
       t.subdomain,
       t.id AS tenant_id
     FROM platform_channel_links pcl
     JOIN users u ON u.id = pcl.user_id
     JOIN tenants t ON t.user_id = pcl.user_id AND t.status = 'active'
     WHERE pcl.platform = 'telegram'
       AND pcl.platform_user_id = $1
       AND pcl.is_active = true
     LIMIT 1`,
    [String(telegramUserId)],
  );

  if (!fallback.rows[0]) return null;

  const row = fallback.rows[0];
  const meta = row.platform_meta || {};
  return {
    userId: row.user_id,
    email: row.email,
    subdomain: row.subdomain || '',
    tenantId: row.tenant_id || '',
    telegramUsername: meta.username || null,
    telegramFirstName: meta.firstName || null,
    telegramChatId: null,
    linkedVia: 'deep_link',
    lastSeenAt: null,
  };
}

/**
 * Create or update a Telegram account link.
 *
 * @param {string} mawadaoUserId - UUID of the mawaDao user
 * @param {object} telegramData - { telegramUserId, chatId, username, firstName, lastName }
 * @param {'widget'|'deep_link'|'manual'} linkedVia
 */
async function linkTelegramUser(mawadaoUserId, telegramData, linkedVia = 'deep_link') {
  const { telegramUserId, chatId, username, firstName, lastName } = telegramData;

  // Upsert into telegram_channel_links
  await pool.query(
    `INSERT INTO telegram_channel_links
       (mawadao_user_id, telegram_user_id, telegram_chat_id, telegram_username,
        telegram_first_name, telegram_last_name, linked_via, is_active, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET
       mawadao_user_id      = EXCLUDED.mawadao_user_id,
       telegram_chat_id    = COALESCE(EXCLUDED.telegram_chat_id, telegram_channel_links.telegram_chat_id),
       telegram_username   = COALESCE(EXCLUDED.telegram_username, telegram_channel_links.telegram_username),
       telegram_first_name = COALESCE(EXCLUDED.telegram_first_name, telegram_channel_links.telegram_first_name),
       telegram_last_name  = COALESCE(EXCLUDED.telegram_last_name, telegram_channel_links.telegram_last_name),
       linked_via          = EXCLUDED.linked_via,
       is_active           = true,
       last_seen_at        = NOW(),
       updated_at          = NOW()`,
    [mawadaoUserId, BigInt(telegramUserId), chatId ? BigInt(chatId) : BigInt(telegramUserId), username || null, firstName || null, lastName || null, linkedVia],
  );

  // Also upsert into platform_channel_links for backward compatibility
  const platformMeta = JSON.stringify({
    firstName: firstName || null,
    lastName: lastName || null,
    username: username || null,
  });
  await pool.query(
    `INSERT INTO platform_channel_links
       (user_id, platform, platform_user_id, platform_meta, is_active, linked_at)
     VALUES ($1, 'telegram', $2, $3, true, NOW())
     ON CONFLICT (platform, platform_user_id)
     DO UPDATE SET
       user_id       = EXCLUDED.user_id,
       platform_meta = EXCLUDED.platform_meta,
       is_active     = true,
       linked_at     = NOW(),
       updated_at    = NOW()`,
    [mawadaoUserId, String(telegramUserId), platformMeta],
  );

  console.log(`[telegram-store] Linked user ${mawadaoUserId} ← telegram ${telegramUserId} via ${linkedVia}`);
}

/**
 * Deactivate a Telegram link by telegram_user_id.
 * @param {string|number} telegramUserId
 */
async function unlinkTelegramUser(telegramUserId) {
  await pool.query(
    `UPDATE telegram_channel_links SET is_active = false, updated_at = NOW()
     WHERE telegram_user_id = $1`,
    [BigInt(telegramUserId)],
  );

  // Also deactivate in platform_channel_links for consistency
  await pool.query(
    `UPDATE platform_channel_links SET is_active = false, updated_at = NOW()
     WHERE platform = 'telegram' AND platform_user_id = $1`,
    [String(telegramUserId)],
  );

  console.log(`[telegram-store] Unlinked telegram ${telegramUserId}`);
}

/**
 * Update last_seen_at for a Telegram user.
 * @param {string|number} telegramUserId
 */
async function updateLastSeen(telegramUserId) {
  try {
    await pool.query(
      `UPDATE telegram_channel_links SET last_seen_at = NOW()
       WHERE telegram_user_id = $1 AND is_active = true`,
      [BigInt(telegramUserId)],
    );
  } catch {
    // Non-critical — silently ignore
  }
}

/**
 * Find Telegram chat_id for outbound delivery by mawaDao user_id.
 * @param {string} mawadaoUserId
 * @returns {Promise<{chatId: string, telegramUsername: string}|null>}
 */
async function findTelegramChatByUserId(mawadaoUserId) {
  try {
    const result = await pool.query(
      `SELECT telegram_chat_id, telegram_user_id, telegram_username
       FROM telegram_channel_links
       WHERE mawadao_user_id = $1 AND is_active = true
       LIMIT 1`,
      [mawadaoUserId],
    );

    if (result.rows[0]) {
      return {
        chatId: String(result.rows[0].telegram_chat_id || result.rows[0].telegram_user_id),
        telegramUsername: result.rows[0].telegram_username,
      };
    }
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[telegram-store] findTelegramChatByUserId error:', err.message);
    }
  }

  // Fallback to platform_channel_links
  const fallback = await pool.query(
    `SELECT platform_user_id, platform_meta
     FROM platform_channel_links
     WHERE user_id = $1 AND platform = 'telegram' AND is_active = true
     LIMIT 1`,
    [mawadaoUserId],
  );

  if (!fallback.rows[0]) return null;
  return {
    chatId: fallback.rows[0].platform_user_id,
    telegramUsername: (fallback.rows[0].platform_meta || {}).username || null,
  };
}

// ---------------------------------------------------------------------------
// Message Logging — telegram_message_logs
// ---------------------------------------------------------------------------

/**
 * Log a Telegram message (inbound or outbound) to telegram_message_logs.
 *
 * @param {object} params
 * @param {number} [params.updateId]
 * @param {string} [params.mawadaoUserId]
 * @param {number|string} params.telegramUserId
 * @param {number|string} params.chatId
 * @param {'inbound'|'outbound'} params.direction
 * @param {string} [params.text]
 * @param {number} [params.messageId] - Telegram message_id
 * @param {string} [params.status] - 'pending', 'sent', 'delivered', 'failed', 'duplicate'
 * @param {string} [params.error]
 * @param {object} [params.metadata]
 */
async function logMessage(params) {
  try {
    await pool.query(
      `INSERT INTO telegram_message_logs
         (telegram_update_id, mawadao_user_id, telegram_user_id, telegram_chat_id,
          direction, message_text, telegram_message_id, status, error, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (telegram_update_id) DO NOTHING`,
      [
        params.updateId || null,
        params.mawadaoUserId || null,
        params.telegramUserId ? BigInt(params.telegramUserId) : null,
        params.chatId ? BigInt(params.chatId) : null,
        params.direction,
        params.text ? params.text.slice(0, 10000) : null, // cap stored text
        params.messageId || null,
        params.status || 'sent',
        params.error || null,
        params.metadata ? JSON.stringify(params.metadata) : '{}',
      ],
    );
  } catch (err) {
    // Logging should never block message processing
    console.error('[telegram-store] logMessage failed:', err.message);
  }
}

module.exports = {
  isDuplicateUpdate,
  markUpdateProcessed,
  isRateLimited,
  findTelegramUser,
  linkTelegramUser,
  unlinkTelegramUser,
  updateLastSeen,
  findTelegramChatByUserId,
  logMessage,
};
