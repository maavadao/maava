/**
 * Telegram Bot API Client
 *
 * Clean wrapper for the Telegram Bot API with:
 * - Markdown fallback (MarkdownV2 → Markdown → plain text)
 * - Smart message chunking (respects 4096 char limit)
 * - Structured error handling
 * - All commonly used Bot API methods
 */
const config = require('./config');

const API_BASE = `https://api.telegram.org/bot${config.telegram.botToken}`;
const MAX_MESSAGE_LENGTH = config.telegram.messageMaxLength || 4096;
const CHUNK_SIZE = MAX_MESSAGE_LENGTH - 96; // leave room for "... (continued)" markers

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Make a request to the Telegram Bot API.
 * @param {string} method - Bot API method (e.g. 'sendMessage')
 * @param {object} params - Request body
 * @returns {Promise<object>} Telegram API response
 */
async function callApi(method, params = {}) {
  const url = `${API_BASE}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({ ok: false, description: 'Invalid JSON response' }));

  if (!data.ok) {
    const err = new Error(`Telegram API ${method}: ${data.description || 'Unknown error'}`);
    err.code = data.error_code;
    err.method = method;
    err.params = params;
    throw err;
  }

  return data.result;
}

/**
 * Split text into chunks that fit within Telegram's message limit.
 * Tries to split on newlines first, then on spaces, then hard-cuts.
 */
function chunkText(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    let cutAt = CHUNK_SIZE;

    // Try to cut at a newline boundary
    const lastNewline = remaining.lastIndexOf('\n', cutAt);
    if (lastNewline > cutAt * 0.5) {
      cutAt = lastNewline;
    } else {
      // Try to cut at a space boundary
      const lastSpace = remaining.lastIndexOf(' ', cutAt);
      if (lastSpace > cutAt * 0.5) {
        cutAt = lastSpace;
      }
    }

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Public API — Sending messages
// ---------------------------------------------------------------------------

/**
 * Send a text message with Markdown fallback.
 * If Markdown parsing fails, retries as plain text.
 *
 * @param {number|string} chatId
 * @param {string} text
 * @param {object} [opts] - Extra options (reply_to_message_id, reply_markup, etc.)
 * @returns {Promise<object[]>} Array of sent message results (one per chunk)
 */
async function sendMessage(chatId, text, opts = {}) {
  const chunks = chunkText(text);
  const results = [];

  for (const chunk of chunks) {
    const parseMode = opts.parse_mode || config.telegram.parseMode || 'Markdown';
    const params = {
      chat_id: chatId,
      text: chunk,
      parse_mode: parseMode,
      ...opts,
    };

    try {
      const result = await callApi('sendMessage', params);
      results.push(result);
    } catch (err) {
      // If Markdown parse failed, retry without parse_mode
      if (err.code === 400 && /parse|entities/i.test(err.message)) {
        console.log(`[telegram-api] Markdown parse failed for chat ${chatId}, retrying plain`);
        const plainParams = { ...params };
        delete plainParams.parse_mode;
        try {
          const result = await callApi('sendMessage', plainParams);
          results.push(result);
        } catch (plainErr) {
          console.error(`[telegram-api] Plain text send also failed:`, plainErr.message);
          throw plainErr;
        }
      } else {
        throw err;
      }
    }
  }

  return results;
}

/**
 * Send a chat action (typing indicator, upload_photo, etc.)
 * @param {number|string} chatId
 * @param {string} [action='typing']
 */
async function sendChatAction(chatId, action = 'typing') {
  try {
    await callApi('sendChatAction', { chat_id: chatId, action });
  } catch {
    // Non-critical — silently ignore
  }
}

/**
 * Edit an existing message's text.
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} text
 * @param {object} [opts]
 */
async function editMessageText(chatId, messageId, text, opts = {}) {
  return callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parse_mode || config.telegram.parseMode || 'Markdown',
    ...opts,
  });
}

/**
 * Answer a callback query (from inline keyboard buttons).
 * @param {string} callbackQueryId
 * @param {object} [opts] - { text, show_alert, url, cache_time }
 */
async function answerCallbackQuery(callbackQueryId, opts = {}) {
  return callApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...opts,
  });
}

/**
 * Send a photo.
 * @param {number|string} chatId
 * @param {string} photo - File ID, HTTP URL, or "attach://" reference
 * @param {object} [opts] - { caption, parse_mode, reply_markup }
 */
async function sendPhoto(chatId, photo, opts = {}) {
  return callApi('sendPhoto', {
    chat_id: chatId,
    photo,
    ...opts,
  });
}

/**
 * Send a document.
 * @param {number|string} chatId
 * @param {string} document - File ID, HTTP URL, or "attach://" reference
 * @param {object} [opts] - { caption, parse_mode, reply_markup }
 */
async function sendDocument(chatId, document, opts = {}) {
  return callApi('sendDocument', {
    chat_id: chatId,
    document,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Webhook management
// ---------------------------------------------------------------------------

/**
 * Register a webhook URL with Telegram.
 * @param {string} url - HTTPS URL for webhook
 * @param {object} [opts] - { secret_token, allowed_updates, max_connections, drop_pending_updates }
 */
async function setWebhook(url, opts = {}) {
  const params = { url, ...opts };
  if (!params.allowed_updates) {
    params.allowed_updates = config.telegram.allowedUpdates || ['message', 'edited_message', 'callback_query'];
  }
  if (config.telegram.webhookSecret && !params.secret_token) {
    params.secret_token = config.telegram.webhookSecret;
  }
  return callApi('setWebhook', params);
}

/**
 * Remove the webhook (switches bot to getUpdates mode).
 * @param {boolean} [dropPending=false] - Drop pending updates
 */
async function deleteWebhook(dropPending = false) {
  return callApi('deleteWebhook', { drop_pending_updates: dropPending });
}

/**
 * Get current webhook configuration and status.
 * @returns {Promise<object>} WebhookInfo object
 */
async function getWebhookInfo() {
  return callApi('getWebhookInfo');
}

/**
 * Get bot info (useful for verifying bot username).
 */
async function getMe() {
  return callApi('getMe');
}

module.exports = {
  callApi,
  chunkText,
  sendMessage,
  sendChatAction,
  editMessageText,
  answerCallbackQuery,
  sendPhoto,
  sendDocument,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  getMe,
};
