#!/usr/bin/env node
/**
 * Telegram Webhook Management Script
 *
 * Usage:
 *   node scripts/telegram-webhook.js set     — Register the webhook URL
 *   node scripts/telegram-webhook.js delete  — Remove the webhook
 *   node scripts/telegram-webhook.js info    — Show current webhook info
 *   node scripts/telegram-webhook.js me      — Show bot identity (getMe)
 */

const https = require('https');
const { URL } = require('url');

// ─── Config ─────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_BASE_URL = process.env.TELEGRAM_WEBHOOK_BASE_URL;
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook';
const SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALLOWED_UPDATES = (process.env.TELEGRAM_ALLOWED_UPDATES || 'message,edited_message,callback_query').split(',').map(s => s.trim());

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required. Set it in your environment.');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function callApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`);

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Telegram API error: ${parsed.description || JSON.stringify(parsed)}`));
          } else {
            resolve(parsed.result);
          }
        } catch {
          reject(new Error(`Invalid JSON from Telegram: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ─── Commands ───────────────────────────────────────────────────────────

async function setWebhook() {
  if (!WEBHOOK_BASE_URL) {
    console.error('TELEGRAM_WEBHOOK_BASE_URL is required for "set" command.');
    process.exit(1);
  }
  const webhookUrl = `${WEBHOOK_BASE_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
  const params = {
    url: webhookUrl,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  };
  if (SECRET_TOKEN) {
    params.secret_token = SECRET_TOKEN;
  }
  console.log(`Setting webhook to: ${webhookUrl}`);
  console.log(`Allowed updates: ${ALLOWED_UPDATES.join(', ')}`);
  const result = await callApi('setWebhook', params);
  console.log('Result:', result);
}

async function deleteWebhook() {
  console.log('Deleting webhook...');
  const result = await callApi('deleteWebhook', { drop_pending_updates: false });
  console.log('Result:', result);
}

async function getInfo() {
  const info = await callApi('getWebhookInfo');
  console.log('Webhook Info:');
  console.log(JSON.stringify(info, null, 2));
}

async function getMe() {
  const me = await callApi('getMe');
  console.log('Bot Info:');
  console.log(JSON.stringify(me, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────────

const command = process.argv[2];

(async () => {
  try {
    switch (command) {
      case 'set':    await setWebhook(); break;
      case 'delete': await deleteWebhook(); break;
      case 'info':   await getInfo(); break;
      case 'me':     await getMe(); break;
      default:
        console.log('Usage: node scripts/telegram-webhook.js <set|delete|info|me>');
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
