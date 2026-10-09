/**
 * Channel Router — Entry point.
 *
 * A lightweight microservice that owns the platform bots (Telegram, Discord, WhatsApp)
 * and routes incoming messages to each user's maava instance via REST API.
 *
 * Architecture:
 *   Platform Webhook → Channel Router → DB lookup → maava REST → Reply
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
  res.json({ service: 'maava-channels', status: 'ok' });
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
  console.log(`[maava-channels] Listening on port ${config.port}`);
  console.log(`[maava-channels] DATABASE_URL set: ${!!config.database.url}`);
  console.log(`[maava-channels] DATABASE_URL host: ${config.database.url ? new URL(config.database.url).hostname : 'N/A'}`);
  console.log(`[maava-channels] TELEGRAM_BOT_TOKEN set: ${!!config.telegram.botToken}`);
  console.log(`[maava-channels] PUBLIC_BASE_URL: ${config.publicBaseUrl}`);

  // Test DB connectivity
  const pool = require('./db');
  try {
    const dbTest = await pool.query('SELECT NOW() AS now');
    console.log(`[maava-channels] ✅ DB connected — server time: ${dbTest.rows[0].now}`);
  } catch (dbErr) {
    console.error(`[maava-channels] ❌ DB connection FAILED:`, dbErr.message);
  }

  // Set up Telegram webhook (non-blocking)
  setupTelegramWebhook().catch((err) =>
    console.error('[maava-channels] Telegram webhook setup failed:', err),
  );

  // Start Discord bot (long-running WebSocket)
  startDiscordBot().catch((err) =>
    console.error('[maava-channels] Discord bot startup failed:', err),
  );

  console.log('[maava-channels] All handlers initialized');
});
