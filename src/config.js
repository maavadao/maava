/**
 * Channel Router — Configuration
 */
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 8090,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  database: {
    url: process.env.DATABASE_URL,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || 'mawadao_bot',
    webhookBaseUrl: process.env.TELEGRAM_WEBHOOK_BASE_URL || '', // e.g. https://channel-router.mawadao.com
    webhookPath: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook',
    allowedUpdates: (process.env.TELEGRAM_ALLOWED_UPDATES || 'message,edited_message,callback_query').split(',').map(s => s.trim()),
    parseMode: process.env.TELEGRAM_PARSE_MODE || 'Markdown',
    connectLinkTtlMinutes: parseInt(process.env.TELEGRAM_CONNECT_LINK_TTL_MINUTES, 10) || 10,
    rateLimitPerMinute: parseInt(process.env.TELEGRAM_RATE_LIMIT_PER_MINUTE, 10) || 30,
    messageMaxLength: parseInt(process.env.TELEGRAM_MESSAGE_MAX_LENGTH, 10) || 4096,
    enableLoginWidget: process.env.TELEGRAM_ENABLE_LOGIN_WIDGET === 'true',
    enableDeepLinkLinking: process.env.TELEGRAM_ENABLE_DEEP_LINK !== 'false', // on by default
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  },

  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  },

  // JWT secret — must match dashboard/auth service for token verification
  jwtSecret: process.env.JWT_SECRET || '',

  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:8090',
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || 'https://agent.mawadao.com',
  outboundSecret: process.env.OUTBOUND_SECRET || '',
};
