/**
 * Channel Router — Entry point.
 *
 * A lightweight microservice that owns the platform bots (Telegram, Discord, WhatsApp)
 * and routes incoming messages to each user's mawa instance via REST API.
 *
 * Architecture:
 *   Platform Webhook → Channel Router → DB lookup → mawa REST → Reply
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const { telegramRouter, setupTelegramWebhook } = require('./telegram');
const { discordRouter, startDiscordBot } = require('./discord');
const { whatsappRouter } = require('./whatsapp');
const { outboundRouter } = require('./outbound');

const app = express();

// Security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'mawa-channels', status: 'ok' });
});
app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

// Mount platform handlers
app.use('/telegram', telegramRouter);
app.use('/discord', discordRouter);
app.use('/whatsapp', whatsappRouter);
app.use('/api/outbound', outboundRouter);

// Start
app.listen(config.port, async () => {
  console.log(`[mawa-channels] Listening on port ${config.port}`);
  console.log(`[mawa-channels] DATABASE_URL set: ${!!config.database.url}`);
  console.log(`[mawa-channels] DATABASE_URL host: ${config.database.url ? new URL(config.database.url).hostname : 'N/A'}`);
  console.log(`[mawa-channels] TELEGRAM_BOT_TOKEN set: ${!!config.telegram.botToken}`);
  console.log(`[mawa-channels] PUBLIC_BASE_URL: ${config.publicBaseUrl}`);

  // Test DB connectivity
  const pool = require('./db');
  try {
    const dbTest = await pool.query('SELECT NOW() AS now');
    console.log(`[mawa-channels] ✅ DB connected — server time: ${dbTest.rows[0].now}`);
  } catch (dbErr) {
    console.error(`[mawa-channels] ❌ DB connection FAILED:`, dbErr.message);
  }

  // Set up Telegram webhook (non-blocking)
  setupTelegramWebhook().catch((err) =>
    console.error('[mawa-channels] Telegram webhook setup failed:', err),
  );

  // Start Discord bot (long-running WebSocket)
  startDiscordBot().catch((err) =>
    console.error('[mawa-channels] Discord bot startup failed:', err),
  );

  console.log('[mawa-channels] All handlers initialized');
});
