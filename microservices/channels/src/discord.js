/**
 * Discord Handler — A single mawaDao-owned Discord bot that lives in
 * users' servers. Routes DMs and mentions to their mawa instance.
 *
 * Two parts:
 *   1. discord.js Client (long-running) — listens for messages
 *   2. Express routes — OAuth callback for "Add to Server" flow
 */
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { Router } = require('express');
const config = require('./config');
const pool = require('./db');
const { findUserByPlatformId, routeMessage } = require('./router');

const router = Router();

// ---------------------------------------------------------------------------
// Discord.js Bot Client
// ---------------------------------------------------------------------------

let discordClient = null;

async function startDiscordBot() {
  if (!config.discord.botToken) {
    console.warn('[discord] No DISCORD_BOT_TOKEN set — skipping bot startup');
    return;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.once(Events.ClientReady, (c) => {
    console.log(`[discord] Bot ready as ${c.user.tag}`);
  });

  discordClient.on(Events.MessageCreate, async (message) => {
    // Ignore own messages and other bots
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMention = message.mentions.has(discordClient.user);

    // Only respond to DMs or @mentions
    if (!isDM && !isMention) return;

    const discordUserId = message.author.id;
    const text = message.content
      .replace(/<@!?\d+>/g, '') // strip mentions
      .trim();

    if (!text) return;

    try {
      // Look up by discord user ID
      const user = await findUserByPlatformId('discord', discordUserId);
      if (!user) {
        await message.reply(
          `I don't recognize your Discord account yet.\n` +
          `Link it at: ${config.dashboardBaseUrl}/channels/discord`,
        );
        return;
      }

      // Route to mawa
      await message.channel.sendTyping();
      const reply = await routeMessage(user.runtimeEndpoint, user.gatewayToken, text);

      // Discord has a 2000-char limit
      const chunks = [];
      for (let i = 0; i < reply.length; i += 1900) {
        chunks.push(reply.slice(i, i + 1900));
      }
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error('[discord] Error handling message:', err);
      await message.reply('Something went wrong processing your message. Please try again.').catch(() => {});
    }
  });

  await discordClient.login(config.discord.botToken);
}

// ---------------------------------------------------------------------------
// OAuth2: "Add to Server" flow
// ---------------------------------------------------------------------------

/**
 * GET /discord/oauth/callback
 * Discord redirects here after user authorizes the bot to their server.
 * We store guild_id + discord user_id in a temporary state, but the real
 * linking happens when the user confirms on the dashboard.
 */
router.get('/oauth/callback', async (req, res) => {
  const { code, guild_id, state } = req.query;

  if (!code || !guild_id) {
    return res.status(400).send('Missing code or guild_id');
  }

  try {
    // Exchange code for access token to get user identity
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.publicBaseUrl}/discord/oauth/callback`,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('[discord] OAuth token exchange failed:', tokenData);
      return res.status(400).send('OAuth failed');
    }

    // Get user info
    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    // The `state` param contains the mawaDao user_id (set by the frontend)
    const mawadaoUserId = state;
    if (!mawadaoUserId) {
      return res.status(400).send('Missing state (user ID)');
    }

    // Upsert platform_channel_links
    await pool.query(
      `INSERT INTO platform_channel_links
         (user_id, platform, platform_user_id, platform_meta, is_active, linked_at)
       VALUES ($1, 'discord', $2, $3::jsonb, true, NOW())
       ON CONFLICT (platform, platform_user_id)
       DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         platform_meta = EXCLUDED.platform_meta,
         is_active     = true,
         linked_at     = NOW(),
         updated_at    = NOW()`,
      [
        mawadaoUserId,
        discordUser.id,
        JSON.stringify({
          username: discordUser.username,
          discriminator: discordUser.discriminator,
          avatar: discordUser.avatar,
          guildId: guild_id,
        }),
      ],
    );

    // Redirect back to dashboard
    res.redirect(`${config.dashboardBaseUrl}/channels/discord?linked=true`);
  } catch (err) {
    console.error('[discord] OAuth callback error:', err);
    res.status(500).send('Internal error');
  }
});

/**
 * GET /discord/invite
 * Returns the bot invite URL for the frontend to open.
 */
router.get('/invite', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    permissions: '274877975552', // Send Messages, Read Message History, Embed Links, Attach Files
    scope: 'bot identify',
    response_type: 'code',
    redirect_uri: `${config.publicBaseUrl}/discord/oauth/callback`,
    state: userId,
  });

  res.json({
    url: `https://discord.com/api/oauth2/authorize?${params.toString()}`,
  });
});

/**
 * Send a DM to a Discord user by their Discord user ID.
 * Used by the outbound delivery API.
 */
async function sendDiscordDM(discordUserId, text) {
  if (!discordClient) {
    throw new Error('Discord bot not started');
  }
  const user = await discordClient.users.fetch(discordUserId);
  const dm = await user.createDM();
  // Discord 2000-char limit
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push(text.slice(i, i + 1900));
  }
  for (const chunk of chunks) {
    await dm.send(chunk);
  }
}

module.exports = { discordRouter: router, startDiscordBot, sendDiscordDM };
