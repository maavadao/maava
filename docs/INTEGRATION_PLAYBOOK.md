# mawaDao Agent Integration Playbook — Production Implementation Guide

> **Version:** 1.0 | **Date:** 2026-03-25 | **Scope:** All 8 Use Cases

---

## 1. Executive Summary

This document maps every required skill/integration across all 8 mawaDao Agent use cases to a verified implementation path. The mawaDao Agent platform supports five integration modes, listed here in preference order:

1. **Native Channel** — built-in bidirectional messaging (Slack, Discord, Telegram, WhatsApp, etc.)
2. **Composio Toolkit** — 980+ pre-built toolkits with managed OAuth; best for outbound actions against SaaS APIs
3. **ClawHub / Community Skill** — SKILL.md-based from the mawaDao Agent marketplace; installed via `openclaw skills install`
4. **Direct MCP Server** — Model Context Protocol server called via the bundled `mcporter` skill; best for research/planning tools
5. **Custom Skill / Plugin** — hand-written SKILL.md or plugin when nothing above exists

### Preferred Default Stack

| Layer | Default |
|---|---|
| Inbound messaging | Native mawaDao Agent channel (Slack, Telegram, WhatsApp, Discord) |
| Outbound SaaS actions | Composio toolkit (Gmail, Google Calendar, Google Sheets, HubSpot, etc.) |
| Research / scraping | Direct MCP (Tavily, Firecrawl) |
| Social media publishing | ClawHub community skill (Zernio, PostFast, Post Bridge) |
| Crypto execution | ClawHub community skill (Bankr, Bankr Signals, QuickNode) |
| Everything else | Custom SKILL.md wrapping REST API |

---

## 2. Canonical Integration Modes

### 2A. Native Channel

**What it is:** A built-in adapter in the mawaDao Agent gateway that handles inbound messages from a platform and delivers agent replies back.

**Built-in channels:** Slack, Discord, Telegram, WhatsApp, Signal, iMessage, Teams, Matrix, Zalo, WebChat

**Config pattern:**
```yaml
channels:
  slack:
    enabled: true
    botToken: "xoxb-..."
    actions:
      reactions: true
      pins: true
```

**When to use:** When the user wants to *chat with the agent from* that platform (inbound). A native channel handles message routing, threading, reactions, and delivery.

**Important distinction:** A native channel is *inbound*. If the agent needs to *send* a Slack message proactively (outbound action), you also need the Slack toolkit/skill.

---

### 2B. Composio Toolkit

**What it is:** A managed integration layer with 980+ pre-built toolkits. Composio handles OAuth flows, token refresh, rate limiting, and exposes actions as tool calls.

**Install pattern:**
```bash
# Install the Composio mawaDao Agent plugin (one-time)
openclaw plugins install composio

# In gateway config
plugins:
  entries:
    composio:
      config:
        apiKey: "your-composio-api-key"

# Users authenticate individual apps via chat or settings
```

**Auth model:** Per-user OAuth. Each tenant user connects their own Google, HubSpot, Slack, etc. account through Composio's managed auth flow. Composio stores tokens securely.

**Composio toolkits verified available:**
- Gmail (OAUTH2 / BEARER TOKEN)
- Google Calendar (OAUTH2 / BEARER TOKEN)
- Google Drive (OAUTH2 / BEARER TOKEN)
- Google Sheets (OAUTH2)
- Notion (OAUTH2 / API KEY)
- Slack (OAUTH2 / BEARER TOKEN)
- HubSpot (OAUTH2 / BEARER TOKEN)
- Stripe (API KEY)
- Shopify (API KEY)
- Linear (OAUTH2 / API KEY)
- Salesforce (OAUTH2)
- Pipedrive (OAUTH2 / API KEY)
- Twitter/X (OAUTH2 / BEARER TOKEN)
- Firecrawl (API KEY)
- Tavily (API KEY)
- Calendly (OAUTH2)
- Discord (OAUTH2)
- Mixpanel (API KEY)
- PostHog (API KEY)
- Xero (OAUTH2)

**When to use:** Whenever the agent needs to *perform actions* on a SaaS product (send email, create calendar event, update CRM deal, post to Slack channel). Composio is the default for outbound SaaS actions.

**Fallback:** If Composio plugin is not installed, use platform-managed API keys via `skill-connections.ts` + custom skill.

---

### 2C. ClawHub / Community Skill

**What it is:** A SKILL.md file published to ClawHub, installable via CLI.

**Install pattern:**
```bash
openclaw skills search "zernio"
openclaw skills install mikipalet/zernio-api
# Or via npx:
npx clawhub@latest install mikipalet/zernio-api
```

**Config:** Environment variables in `~/.openclaw/.env` or workspace config.

**When to use:** For specialized domain skills (social media posting, crypto trading, voice calls) that are community-maintained.

---

### 2D. Direct MCP Server

**What it is:** A Model Context Protocol server that exposes tools over HTTP or stdio. Called from mawaDao Agent via the bundled `mcporter` skill.

**Install pattern (Remote MCP):**
```bash
# Agent uses mcporter in conversation:
mcporter call https://mcp.tavily.com/mcp/?tavilyApiKey=YOUR_KEY tavily-search query="latest AI news"
```

**Install pattern (Local MCP):**
```json
{
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp@latest"],
      "env": {
        "TAVILY_API_KEY": "your-key"
      }
    }
  }
}
```

**When to use:** For research, scraping, and data retrieval tools (Tavily search, Firecrawl scrape). MCP is read-heavy and stateless.

---

### 2E. Custom Skill / Plugin

**What it is:** A hand-written SKILL.md (or plugin with `openclaw.plugin.json`) that wraps a REST API.

**When to use:** When no native channel, Composio toolkit, ClawHub skill, or MCP server exists for the integration. See Section 7 for the template.

---

## 3. Full Deduplicated Skill Catalog

| # | Skill Name | Provider | Use Cases | Priority | Verified | Recommended Path | Install Method | Auth Method | Risk Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Tavily MCP** | Tavily | E-Com, Social, Lead, Monitor, HubSpot, Crypto | Critical | ✅ Verified | Direct MCP (remote or local) | `npx -y tavily-mcp@latest` | API key (`TAVILY_API_KEY`) | Read-only, low risk |
| 2 | **Slack** | Slack | All 8 | Critical | ✅ Verified | Native channel (inbound) + Composio toolkit (outbound) | Built-in channel + `openclaw plugins install composio` | Bot token (channel) / OAuth (Composio) | Low risk |
| 3 | **Gmail** | Google | All except Crypto | Critical | ✅ Verified | Composio toolkit | Composio plugin | OAuth per-user | Medium — sending email on user's behalf |
| 4 | **Notion MCP** | Notion | 7 of 8 | Critical | ✅ Verified | Composio toolkit (preferred) or custom skill | Composio plugin or `NOTION_API_KEY` | OAuth (Composio) / API key (custom) | Low risk |
| 5 | **Google Sheets** | Google | E-Com, Schedule, Report, Monitor, Crypto | Critical | ✅ Verified | Composio toolkit | Composio plugin | OAuth per-user | Low risk |
| 6 | **WhatsApp** | Meta | E-Com, Lead, Schedule | Critical | ✅ Verified | Native channel (inbound) + custom skill (outbound) | Built-in channel | Business API credentials / phone number | High — messaging real users |
| 7 | **Telegram** | Telegram | Lead, Schedule, Monitor | Critical | ✅ Verified | Native channel (inbound) + custom skill (outbound) | Built-in channel | Bot token (`TELEGRAM_BOT_TOKEN`) | Medium — messaging users |
| 8 | **Firecrawl MCP** | Firecrawl | E-Com, Monitor, Crypto | Critical | ✅ Verified | Direct MCP (remote or local) | `npx -y firecrawl-mcp` | API key (`FIRECRAWL_API_KEY`) | Read-only scraping, low risk |
| 9 | **Google Calendar** | Google | Schedule, Monitor, HubSpot | Critical | ✅ Verified | Composio toolkit | Composio plugin | OAuth per-user | Medium — creating/modifying events |
| 10 | **HubSpot MCP** | HubSpot | HubSpot CRM, Lead | Important | ✅ Verified | Composio toolkit (preferred) or custom skill | Composio plugin or `HUBSPOT_ACCESS_TOKEN` | OAuth (Composio) / Private App token | Medium — CRM writes |
| 11 | **Stripe MCP** | Stripe | E-Com, Reporting | Important | ✅ Verified | Custom skill (read-only) via `STRIPE_SECRET_KEY` | skill-connections.ts | API key | **High** — financial data. Read-only mode first. |
| 12 | **Google Drive** | Google | Reporting, Monitoring | Important | ✅ Verified | Composio toolkit | Composio plugin | OAuth per-user | Low-medium |
| 13 | **PostFast** | PostFast | Social Media | Important | ⚠️ Needs verification | ClawHub community skill | `openclaw skills search postfast` | API key | Medium — social posting |
| 14 | **Post Bridge** | Post Bridge | Social Media | Important | ⚠️ Needs verification | ClawHub community skill | `openclaw skills search post-bridge` | API key | Medium — social posting |
| 15 | **Shopify** | Shopify | E-Commerce | Important | ✅ Verified | Custom skill via skill-connections.ts | `SHOPIFY_ACCESS_TOKEN` + `SHOPIFY_SHOP_DOMAIN` | Admin API token | **High** — e-commerce mutations. Read-only first. |
| 16 | **Mixpanel** | Mixpanel | Lead, Reporting | Important | ⚠️ Composio available | Composio toolkit | Composio plugin | API key | Low — analytics read |
| 17 | **PostHog** | PostHog | Lead, Reporting | Important | ⚠️ Composio available | Composio toolkit | Composio plugin | API key | Low — analytics read |
| 18 | **ElevenLabs** | ElevenLabs | Scheduling | Important | ✅ Verified | Custom skill (bundled as `sag`) | skill-connections.ts | API key (`ELEVENLABS_API_KEY`) | Medium — voice calls |
| 19 | **Bankr Skill** | Bankr | Crypto Trading | Important | ✅ Verified | ClawHub community skill | `openclaw skills install bankr` | API key + wallet connection | **Critical** — financial execution. Paper mode default. |
| 20 | **Bankr Signals** | Bankr | Crypto Trading | Important | ✅ Verified | ClawHub community skill | `openclaw skills install bankr-signals` | API key | Low — signal feed read |
| 21 | **QuickNode** | QuickNode | Crypto Trading | Important | ⚠️ Needs verification | Custom skill or ClawHub | `openclaw skills search quicknode` | API key / RPC endpoint | Low — on-chain reads |
| 22 | **Zernio** | Zernio | Social Media | Important | ✅ Verified | ClawHub community skill | `npx clawhub@latest install mikipalet/zernio-api` | API key (`ZERNIO_API_KEY`) | Medium — social posting |
| 23 | **Humanizer** | Unknown | Social Media | Nice-to-have | ⚠️ Needs verification | Custom skill | Custom SKILL.md | API key (if any) | Low |
| 24 | **Unified.to** | Unified.to | Lead & Sales | Nice-to-have | ⚠️ Needs verification | Custom skill | Custom SKILL.md | API key | Medium — CRM bridge |
| 25 | **WooCommerce** | WooCommerce | E-Commerce | Nice-to-have | ⚠️ No integration found | Custom skill | Custom SKILL.md | REST API key + secret | **High** — e-commerce mutations |
| 26 | **Google Analytics 4** | Google | Reporting | Nice-to-have | ⚠️ Composio (Google Super) | Composio toolkit (Google Super) | Composio plugin | OAuth per-user | Low — analytics read |
| 27 | **PDF Extraction** | Various | Monitoring | Nice-to-have | ⚠️ Needs verification | Custom skill or MCP | Custom | None or API key | Low |
| 28 | **Linear** | Linear | Monitoring | Nice-to-have | ✅ Verified | Custom skill via skill-connections.ts | `LINEAR_API_KEY` | API key | Low |
| 29 | **Discord** | Discord | Monitoring | Nice-to-have | ✅ Verified | Native channel | Built-in channel | Bot token (`DISCORD_BOT_TOKEN`) | Low |
| 30 | **Xero** | Xero | Reporting | Nice-to-have | ⚠️ Composio available | Composio toolkit | Composio plugin | OAuth | Medium — financial data |
| 31 | **CoinGecko** | CoinGecko | Reporting | Nice-to-have | ⚠️ No integration found | Custom skill | Custom SKILL.md | Free API (rate limited) or Pro API key | Low — price data read |
| 32 | **Calendly** | Calendly | Scheduling | Nice-to-have | ⚠️ Composio available | Composio toolkit | Composio plugin | OAuth | Low-medium |
| 33 | **Eventbrite** | Eventbrite | Scheduling | Nice-to-have | ⚠️ Needs verification | Custom skill | Custom SKILL.md | OAuth / API key | Low |
| 34 | **Luma** | Luma | Scheduling | Nice-to-have | ⚠️ Needs verification | Custom skill | Custom SKILL.md | API key | Low |
| 35 | **Facebook Messenger** | Meta | Lead & Sales | Nice-to-have | ⚠️ Needs verification | Custom skill / plugin | Custom | Page token + App secret | Medium — messaging |
| 36 | **Helixa** | Helixa | Crypto | Nice-to-have | ⚠️ Needs verification | ClawHub community skill | `openclaw skills search helixa` | API key | Low — agent identity |
| 37 | **Neynar** | Neynar | Crypto | Nice-to-have | ⚠️ Needs verification | Custom skill | Custom SKILL.md | API key | Low — Farcaster reads |

---

## 4. Detailed Integration Playbook

### 4.1 Tavily MCP — Web Search & Research

**What it does:** Real-time web search, content extraction, site mapping, and web crawling. Provides agents with up-to-date internet information.

**Where it fits:** Research/planning layer. Agents use Tavily to find information before taking actions.

**Best implementation path:** Direct MCP Server (remote)

**Install steps:**
1. Get API key at https://app.tavily.com/home (free tier available)
2. Configure as remote MCP:
   ```
   Remote URL: https://mcp.tavily.com/mcp/?tavilyApiKey=YOUR_KEY
   ```
3. Or local MCP:
   ```bash
   npx -y tavily-mcp@latest
   # Env: TAVILY_API_KEY=your-key
   ```
4. Agent calls via `mcporter`:
   ```
   mcporter call tavily tavily-search query="competitor pricing for X"
   ```

**Config/Auth:** `TAVILY_API_KEY` — platform-managed API key stored in skill-connections or env.

**Test prompts:**
- "Search for the latest news about OpenAI"
- "Find pricing information for Shopify Plus plans"
- "Extract the main content from https://example.com/blog/post"

**Tools available:** `tavily-search`, `tavily-extract`, `tavily-map`, `tavily-crawl`

**Fallback:** If Tavily is unavailable, use the built-in `web_search` skill with Brave API or DuckDuckGo.

**Documentation:**
- Official: https://docs.tavily.com/documentation/mcp
- GitHub: https://github.com/tavily-ai/tavily-mcp
- API key: https://app.tavily.com/home

---

### 4.2 Slack — Channel + Toolkit

**What it does:** Bidirectional messaging (native channel) and outbound actions (toolkit) in Slack.

**Where it fits:**
- **Native channel** = users chat with the agent *from Slack*
- **Toolkit** = agent *sends messages to Slack* proactively (alerts, digests, notifications)

**Best implementation path:**
- Inbound: Native mawaDao Agent Slack channel
- Outbound: Composio Slack toolkit OR bundled Slack skill

**Install steps (channel):**
1. Create Slack app at https://api.slack.com/apps
2. Add bot scopes: `chat:write`, `channels:read`, `reactions:write`, `pins:write`
3. Install to workspace, get bot token
4. Configure in gateway:
   ```yaml
   channels:
     slack:
       enabled: true
       botToken: "xoxb-..."
       actions:
         reactions: true
         pins: true
   ```

**Install steps (outbound toolkit via Composio):**
1. Composio plugin installed
2. User authenticates Slack via Composio OAuth
3. Agent can: send messages, create channels, pin messages, add reactions

**Config/Auth:** Bot token for channel; OAuth for Composio toolkit

**Test prompts:**
- "Send a summary of today's metrics to #daily-digest on Slack"
- "Pin the latest status update in #team-updates"

**Fallback:** Use direct Slack API with `SLACK_BOT_TOKEN` via custom skill.

**Documentation:**
- mawaDao Agent Slack channel config: gateway docs
- Slack API: https://api.slack.com/
- Composio: https://composio.dev/toolkits/slack

---

### 4.3 Gmail — Outbound Email Actions

**What it does:** Send emails, read inbox, create drafts, manage labels on behalf of users.

**Where it fits:** Outbound notification layer. Agents send follow-ups, reports, alerts via email.

**Best implementation path:** Composio Gmail toolkit

**Install steps:**
1. Composio plugin installed
2. User authenticates their Google account via Composio OAuth flow
3. Agent can: send email, read messages, create drafts, add labels, search inbox

**Config/Auth:** OAuth per-user via Composio. No API keys needed — each user connects their own Gmail.

**Safety gates:** Draft mode recommended — agent creates drafts, user reviews and sends. For automated sending, require explicit user opt-in.

**Test prompts:**
- "Draft an email to john@company.com with the weekly report"
- "Check my inbox for unread messages from support@vendor.com"

**Fallback:** Custom skill using SendGrid (`SENDGRID_API_KEY` in skill-connections.ts) for platform-sent transactional emails. Or use Gmail API directly with OAuth service account.

**Documentation:**
- Composio: https://composio.dev/toolkits/gmail
- Gmail API: https://developers.google.com/gmail/api

---

### 4.4 Notion — Knowledge Base & Task Tracking

**What it does:** Create/read/update pages, databases, and blocks in Notion workspaces.

**Where it fits:** Agent's persistent memory and structured data storage. Agents log activity, store research, create reports.

**Best implementation path:** Composio Notion toolkit (OAuth) or custom skill with API key

**Install steps (Composio):**
1. Composio plugin installed
2. User authenticates Notion workspace
3. Agent can: create pages, query databases, update properties, add content blocks

**Install steps (custom skill):**
1. Create Notion integration at https://www.notion.so/my-integrations
2. Share target pages/databases with the integration
3. Set `NOTION_API_KEY=secret_xxx` in skill-connections
4. Bundled Notion skill already exists in mawaDao Agent

**Config/Auth:** `NOTION_API_KEY` (integration token) already in skill-connections.ts

**Test prompts:**
- "Create a new page in my Notion database with today's meeting notes"
- "Find all tasks marked as 'In Progress' in my project tracker"

**Fallback:** The mawaDao Agent bundled `notion` skill already exists.

**Documentation:**
- mawaDao Agent bundled skill: workspace `skills/notion/SKILL.md`
- Notion API: https://developers.notion.com/
- Composio: https://composio.dev/toolkits/notion

---

### 4.5 Google Sheets — Spreadsheet Data

**What it does:** Read/write/create spreadsheets. Agents can log data, read configurations, generate reports.

**Where it fits:** Structured data I/O. Position tracking, inventory lists, metric logs, KPI dashboards.

**Best implementation path:** Composio Google Sheets toolkit

**Install steps:**
1. Composio plugin installed
2. User authenticates Google account
3. Agent can: read ranges, write data, create sheets, format cells

**Config/Auth:** OAuth per-user via Composio

**Test prompts:**
- "Add today's sales figures to the 'Daily Metrics' spreadsheet"
- "Read the inventory levels from the 'Stock Tracker' sheet"

**Fallback:** Custom skill using Google Sheets API v4 with service account JSON.

**Documentation:**
- Composio: https://composio.dev/toolkits/googlesheets
- Google Sheets API: https://developers.google.com/sheets/api

---

### 4.6 WhatsApp — Business Messaging

**What it does:** Bidirectional messaging via WhatsApp Business API. Users chat with agents from WhatsApp; agents send notifications.

**Where it fits:**
- **Native channel** = users chat with agent from WhatsApp
- **Outbound** = agent sends reminders, follow-ups, alerts

**Best implementation path:** Native mawaDao Agent WhatsApp channel

**Install steps:**
1. Register WhatsApp Business Account via Meta Business Suite
2. Get phone number ID, business account ID, permanent access token
3. Configure in gateway:
   ```yaml
   channels:
     whatsapp:
       enabled: true
       phoneNumberId: "..."
       businessAccountId: "..."
       accessToken: "..."
   ```
4. Set up webhook for inbound messages

**Config/Auth:** WhatsApp Business API credentials (phone number, access token, business account)

**Safety gates:** Template messages only for outbound (WhatsApp policy). User must opt in. 24-hour conversation window rules.

**Test prompts:**
- "Send a reminder to +1234567890 about their appointment tomorrow"
- "Check for any new WhatsApp messages from clients"

**Fallback:** Twilio WhatsApp API (already in skill-connections.ts with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`).

**Documentation:**
- Meta Business: https://business.facebook.com/
- WhatsApp Business API: https://developers.facebook.com/docs/whatsapp/cloud-api

---

### 4.7 Telegram — Bot Messaging

**What it does:** Bidirectional messaging via Telegram bots.

**Where it fits:** Native channel (inbound) + outbound notifications

**Best implementation path:** Native mawaDao Agent Telegram channel

**Install steps:**
1. Create bot via @BotFather on Telegram
2. Get bot token
3. Configure in gateway:
   ```yaml
   channels:
     telegram:
       enabled: true
       botToken: "1234567890:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

**Config/Auth:** `TELEGRAM_BOT_TOKEN` (already in skill-connections.ts)

**Test prompts:**
- "Send a daily digest to the Telegram group"
- "Alert me on Telegram when a new lead comes in"

**Documentation:**
- Telegram Bot API: https://core.telegram.org/bots/api

---

### 4.8 Firecrawl MCP — Web Scraping & Extraction

**What it does:** Scrape, crawl, extract, map, and search web content. AI-powered structured data extraction.

**Where it fits:** Data collection layer. Competitor monitoring, content scraping, price tracking.

**Best implementation path:** Direct MCP Server (local or remote)

**Install steps:**
1. Get API key at https://www.firecrawl.dev/app/api-keys
2. Local MCP:
   ```bash
   npx -y firecrawl-mcp
   # Env: FIRECRAWL_API_KEY=fc-YOUR_KEY
   ```
3. Agent calls via `mcporter`:
   ```
   mcporter call firecrawl firecrawl_scrape url="https://competitor.com/pricing"
   ```

**Config/Auth:** `FIRECRAWL_API_KEY` — platform-managed

**Tools available:**
- `firecrawl_scrape` — single page (JSON or markdown)
- `firecrawl_batch_scrape` — multiple URLs
- `firecrawl_search` — web search with content extraction
- `firecrawl_map` — discover all URLs on a site
- `firecrawl_crawl` — multi-page extraction
- `firecrawl_extract` — LLM-powered structured extraction
- `firecrawl_agent` — autonomous research agent

**Test prompts:**
- "Scrape the pricing page of competitor X and extract their plan features"
- "Find all blog post URLs on example.com"

**Fallback:** Built-in `browser_use` skill with Brave API for basic web content.

**Documentation:**
- GitHub: https://github.com/firecrawl/firecrawl-mcp-server
- Docs: https://docs.firecrawl.dev/
- API keys: https://www.firecrawl.dev/app/api-keys

---

### 4.9 Google Calendar — Scheduling

**What it does:** Create, read, update, delete calendar events. Check availability. Set reminders.

**Where it fits:** Scheduling/appointment layer. Booking meetings, sending reminders, managing events.

**Best implementation path:** Composio Google Calendar toolkit

**Install steps:**
1. Composio plugin installed
2. User authenticates Google account
3. Agent can: create events, check free/busy, update events, delete events, list calendars

**Config/Auth:** OAuth per-user via Composio

**Safety gates:** Require confirmation before creating or deleting events. Show event details before modification.

**Test prompts:**
- "Schedule a meeting with the team on Friday at 2 PM"
- "Check my availability next Thursday afternoon"

**Fallback:** Google Calendar API v3 with service account or OAuth credentials via custom skill.

**Documentation:**
- Composio: https://composio.dev/toolkits/googlecalendar
- Google Calendar API: https://developers.google.com/calendar/api

---

### 4.10 HubSpot — CRM Operations

**What it does:** Manage contacts, companies, deals, tasks, tickets, pipelines. Search CRM records. Log activities.

**Where it fits:** CRM operations layer. Lead qualification, deal tracking, pre-call briefing, CRM logging.

**Best implementation path:** Composio HubSpot toolkit (preferred) or custom skill with Private App token

**Install steps (Composio):**
1. Composio plugin installed
2. User authenticates HubSpot account
3. Agent can: CRUD contacts/companies/deals, search records, create tasks, log notes

**Install steps (custom):**
1. Create Private App in HubSpot → Settings → Integrations → Private Apps
2. Select scopes: contacts, companies, deals, tasks, notes, tickets
3. Set `HUBSPOT_ACCESS_TOKEN=pat-xxx` in skill-connections (already in skill-connections.ts)

**Config/Auth:** `HUBSPOT_ACCESS_TOKEN` (Private App token) — already in skill-connections.ts

**Safety gates:** Read-only mode first. Require confirmation for deal creation/updates and contact modifications.

**Test prompts:**
- "Find all open deals in the Sales pipeline worth over $10K"
- "Create a contact for John Smith at Acme Corp"
- "Log a note on deal #123 about today's follow-up call"

**Documentation:**
- HubSpot API: https://developers.hubspot.com/docs/api/crm
- Composio: https://composio.dev/toolkits/hubspot

---

### 4.11 Stripe — Payment & Revenue Data

**What it does:** Read payment data, invoices, subscriptions, customers, charges, refunds.

**Where it fits:** Financial data layer. Revenue reporting, payment monitoring, customer billing info.

**Best implementation path:** Custom skill with `STRIPE_SECRET_KEY` (already in skill-connections.ts)

**Install steps:**
1. Get secret key from https://dashboard.stripe.com/apikeys
2. Set `STRIPE_SECRET_KEY=sk_live_xxx` in skill-connections

**Config/Auth:** `STRIPE_SECRET_KEY` (already in skill-connections.ts)

**Safety gates:** **CRITICAL — Read-only mode only.** Do not allow refunds, charge creation, or subscription modifications without explicit multi-step confirmation. Use restricted API keys with read-only permissions.

**Test prompts:**
- "Show me this month's revenue breakdown by product"
- "List all failed payments in the last 7 days"

**Fallback:** Composio has Stripe toolkit too.

**Documentation:**
- Stripe API: https://stripe.com/docs/api
- Dashboard: https://dashboard.stripe.com/apikeys

---

### 4.12 Google Drive — File Management

**What it does:** Upload/download files, create documents, manage folders, share files.

**Where it fits:** Document storage layer. Report generation, file sharing, document management.

**Best implementation path:** Composio Google Drive toolkit

**Install steps:**
1. Composio plugin installed
2. User authenticates Google account
3. Agent can: list files, read documents, create/upload files, manage sharing

**Config/Auth:** OAuth per-user via Composio

**Test prompts:**
- "Upload the weekly report to the 'Reports' folder in Drive"
- "Find all documents shared with me this week"

**Documentation:**
- Composio: https://composio.dev/toolkits/googledrive
- Google Drive API: https://developers.google.com/drive/api

---

### 4.13 PostFast — Social Media Scheduling

**What it does:** Cross-platform social media scheduling. Simpler tool for basic X/LinkedIn scheduling.

**Where it fits:** Social media publishing layer.

**Best implementation path:** ClawHub community skill

**Verified status:** ⚠️ Needs verification — referenced in guides but no confirmed ClawHub page.

**Install steps:**
```bash
openclaw skills search "postfast"
openclaw skills install <postfast-slug>
```

**Config/Auth:** API key (needs verification)

**Safety gates:** Draft/preview mode before publishing. Show post content for approval.

**Fallback:** Use Zernio (fully verified) as the primary social media skill.

**Documentation:** Needs research — check ClawHub and PostFast provider.

---

### 4.14 Post Bridge Social Manager — Conversational Posting

**What it does:** Chat-driven posting workflows. Good for conversational post creation across platforms.

**Where it fits:** Social media publishing layer.

**Best implementation path:** ClawHub community skill

**Verified status:** ⚠️ Needs verification

**Install steps:**
```bash
openclaw skills search "post-bridge"
openclaw skills install <post-bridge-slug>
```

**Safety gates:** Same as PostFast — draft/preview before publishing.

**Fallback:** Use Zernio.

---

### 4.15 Shopify — E-Commerce Operations

**What it does:** Manage products, orders, inventory, customers, collections via Shopify Admin API.

**Where it fits:** E-commerce operations layer. Order tracking, inventory management, product updates.

**Best implementation path:** Custom skill with Shopify Admin API credentials (already in skill-connections.ts)

**Install steps:**
1. Create Custom App in Shopify Partners
2. Get Admin API access token
3. Set in skill-connections:
   - `SHOPIFY_ACCESS_TOKEN=shpat_xxx`
   - `SHOPIFY_SHOP_DOMAIN=yourshop.myshopify.com`

**Config/Auth:** Already in skill-connections.ts

**Safety gates:** **HIGH RISK — Start read-only.** No order modifications, no product deletions without explicit confirmation. Use a restricted Shopify API token with read-only scopes initially.

**Test prompts:**
- "Show me the 10 lowest-stock products in the store"
- "Get order details for order #1234"

**Documentation:**
- Shopify Admin API: https://shopify.dev/docs/api/admin-rest
- Composio also available: https://composio.dev/toolkits/shopify

---

### 4.16 Mixpanel — Product Analytics

**What it does:** Query event data, user profiles, funnels, retention metrics.

**Where it fits:** Analytics read layer. User behavior analysis, KPI tracking.

**Best implementation path:** Composio Mixpanel toolkit

**Install steps:**
1. Composio plugin installed
2. Set up Mixpanel API key via Composio

**Config/Auth:** API key via Composio

**Test prompts:**
- "Show me the conversion funnel for the last 30 days"
- "What's the user retention rate for week 1?"

**Fallback:** Custom skill using Mixpanel Export API + `MIXPANEL_API_KEY`.

**Documentation:**
- Mixpanel API: https://developer.mixpanel.com/
- Composio: https://composio.dev/toolkits/mixpanel

---

### 4.17 PostHog — Product Analytics

**What it does:** Similar to Mixpanel — events, funnels, session replays, feature flags.

**Where it fits:** Analytics read layer.

**Best implementation path:** Composio PostHog toolkit

**Config/Auth:** API key via Composio

**Fallback:** Custom skill using PostHog API.

**Documentation:**
- PostHog API: https://posthog.com/docs/api
- Composio: https://composio.dev/toolkits/posthog

---

### 4.18 ElevenLabs — Voice / TTS / Voice Calls

**What it does:** Text-to-speech, voice cloning, conversational AI voice agent for phone calls.

**Where it fits:** Voice communication layer. Automated appointment reminder calls, voice notifications.

**Best implementation path:** Bundled skill (`sag` in skill-connections.ts) + custom skill for Conversational AI

**Install steps:**
1. Get API key at https://elevenlabs.io/app/settings/api-keys
2. Set `ELEVENLABS_API_KEY=xxx` in skill-connections (already configured as `sag` entry)

**Config/Auth:** `ELEVENLABS_API_KEY` (already in skill-connections.ts)

**Safety gates:** Voice calls are sensitive. Require explicit user approval before initiating any call. Log all calls.

**Test prompts:**
- "Call the patient to remind them of their appointment tomorrow at 2 PM"
- "Convert this text to speech using a professional voice"

**Documentation:**
- ElevenLabs API: https://docs.elevenlabs.io/api-reference
- Conversational AI: https://elevenlabs.io/docs/conversational-ai

---

### 4.19 Bankr — Crypto Wallet & Trading

**What it does:** Wallet management, portfolio tracking, swap execution, order routing across chains.

**Where it fits:** Crypto execution layer. The primary trading skill.

**Best implementation path:** ClawHub community skill

**Install steps:**
```bash
openclaw skills install bankr
```

**Config/Auth:** Bankr API key + wallet connection

**Safety gates:** **CRITICAL — FINANCIAL EXECUTION.**
- **Paper trading mode by default** — no real money until user explicitly opts in
- Require confirmation for every live trade
- Position size limits, daily loss limits, allowed token whitelist
- Never execute without user-configured risk parameters
- Log every order with full metadata

**Test prompts:**
- "Show my portfolio balance across all connected wallets"
- "Create a paper trade: buy 0.1 ETH at market on Ethereum"

**Documentation:**
- Bankr API docs (via skill README/references)

---

### 4.20 Bankr Signals — Transaction-Verified Signal Feed

**What it does:** Provides transaction-verified trading signals. Read-only feed of validated market signals.

**Where it fits:** Signal/intelligence layer for crypto trading.

**Best implementation path:** ClawHub community skill

**Install steps:**
```bash
openclaw skills install bankr-signals
```

**Config/Auth:** Bankr API key

**Test prompts:**
- "Show me the latest high-confidence trading signals"
- "What validated signals are there for ETH today?"

---

### 4.21 QuickNode — On-Chain Data

**What it does:** Multi-chain RPC access, on-chain balance queries, gas estimation, transaction confirmations.

**Where it fits:** On-chain data layer for crypto trading.

**Best implementation path:** Custom skill or ClawHub (needs verification)

**Install steps:**
```bash
openclaw skills search "quicknode"
# If found: install. Otherwise: custom skill
```

**Config/Auth:** QuickNode API key / RPC endpoint URL

**Test prompts:**
- "Check the ETH balance of wallet 0x..."
- "What's the current gas price on Ethereum?"

**Fallback:** Custom SKILL.md wrapping QuickNode JSON-RPC API.

**Documentation:**
- QuickNode: https://www.quicknode.com/docs

---

### 4.22 Zernio — Social Media Automation (FULLY DOCUMENTED)

**What it does:** Social media posting, scheduling, analytics across 14+ platforms (Twitter/X, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Reddit, Bluesky, Threads, Google Business, Telegram, Snapchat, WhatsApp).

**Where it fits:** Primary social media publishing skill. Already fully documented in base system prompt.

**Best implementation path:** ClawHub community skill (verified, full docs in system)

**Install steps:**
```bash
npx clawhub@latest install mikipalet/zernio-api
echo 'ZERNIO_API_KEY=sk_your_key_here' >> ~/.openclaw/.env
```

**Config/Auth:** `ZERNIO_API_KEY` from https://zernio.com/dashboard/api-keys

**Documentation:** Full docs already in base system prompt (route.ts line 1272+).

---

### 4.23-4.37 Nice-to-Have Integrations (Summary)

| Skill | Recommended Path | Auth | Notes |
|---|---|---|---|
| **Humanizer** | Custom SKILL.md | API key TBD | Text humanization; needs provider verification |
| **Unified.to** | Custom SKILL.md | API key | CRM aggregator (Salesforce/Pipedrive/Zoho); alt: use Composio per-CRM |
| **WooCommerce** | Custom SKILL.md | REST API key + secret | WordPress e-commerce; no existing integration |
| **Google Analytics 4** | Composio (Google Super toolkit) | OAuth | GA4 Data API; available via Composio Google Super |
| **PDF Extraction** | Custom SKILL.md or MCP | None/API key | Use Firecrawl extract for web PDFs |
| **Linear** | Custom skill via skill-connections.ts | `LINEAR_API_KEY` | Already configured |
| **Discord** | Native channel | `DISCORD_BOT_TOKEN` | Already configured |
| **Xero** | Composio toolkit | OAuth | Accounting data |
| **CoinGecko** | Custom SKILL.md | Free API / Pro key | Crypto price data; simple REST wrapper |
| **Calendly** | Composio toolkit | OAuth | Scheduling; verified on Composio |
| **Eventbrite** | Custom SKILL.md | OAuth / API key | Event management |
| **Luma** | Custom SKILL.md | API key | Event ticketing |
| **Facebook Messenger** | Custom plugin | Page token + App secret | Complex setup; consider WhatsApp instead |
| **Helixa** | ClawHub search | API key | Agent reputation (optional crypto) |
| **Neynar** | Custom SKILL.md | API key | Farcaster protocol access |

---

## 5. Use-Case-by-Use-Case Recommended Stack

### 5.1 E-Commerce Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Firecrawl MCP | MCP (npx firecrawl-mcp) | ✅ |
| 2 | Tavily MCP | MCP (remote URL) | ✅ |
| 3 | Slack | Native channel | ✅ |
| 4 | Gmail | Composio toolkit | |
| 5 | Shopify | Custom skill (skill-connections) | ✅ |
| 6 | Google Sheets | Composio toolkit | |
| 7 | Notion | Composio or custom skill | |
| 8 | WhatsApp | Native channel | |
| 9 | Stripe | Custom skill (skill-connections) | |
| 10 | WooCommerce | Custom SKILL.md | |

**Minimum viable stack:** Firecrawl + Tavily + Slack + Shopify (4 integrations)
**Ideal full stack:** All 10

**Safety gates:**
- Shopify: read-only API token initially, no order modifications
- Stripe: read-only, no refunds or charges
- WhatsApp: template messages only for outbound

---

### 5.2 Social Media Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Zernio | ClawHub skill | ✅ |
| 2 | Tavily MCP | MCP | ✅ |
| 3 | Slack | Native channel | |
| 4 | Notion | Composio toolkit | |
| 5 | Gmail | Composio toolkit | |
| 6 | PostFast | ClawHub skill (verify) | |
| 7 | Post Bridge | ClawHub skill (verify) | |
| 8 | Humanizer | Custom skill (verify) | |

**Minimum viable stack:** Zernio + Tavily (2 integrations)
**Ideal full stack:** All 8

**Safety gates:**
- All social posting tools: draft/preview mode, approval gate before publishing
- Never auto-post without explicit user confirmation

---

### 5.3 Lead & Sales Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | HubSpot | Composio or custom skill | ✅ |
| 2 | Gmail | Composio toolkit | ✅ |
| 3 | Tavily MCP | MCP | ✅ |
| 4 | Slack | Native channel | |
| 5 | WhatsApp | Native channel | |
| 6 | Telegram | Native channel | |
| 7 | Notion | Composio toolkit | |
| 8 | Mixpanel/PostHog | Composio toolkit | |
| 9 | Unified.to | Custom SKILL.md | |
| 10 | Facebook Messenger | Custom plugin | |

**Minimum viable stack:** HubSpot + Gmail + Tavily (3 integrations)
**Ideal full stack:** All 10

**Safety gates:**
- CRM writes: confirmation for creating/updating contacts and deals
- Email: draft mode for automated follow-ups
- Messaging channels: opt-in only

---

### 5.4 Scheduling Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Google Calendar | Composio toolkit | ✅ |
| 2 | Gmail | Composio toolkit | ✅ |
| 3 | Slack | Native channel | |
| 4 | WhatsApp | Native channel | |
| 5 | Telegram | Native channel | |
| 6 | Google Sheets | Composio toolkit | |
| 7 | Notion | Composio toolkit | |
| 8 | ElevenLabs | Custom skill (skill-connections) | |
| 9 | Calendly | Composio toolkit | |
| 10 | Eventbrite/Luma | Custom SKILL.md | |

**Minimum viable stack:** Google Calendar + Gmail (2 integrations)
**Ideal full stack:** All 10

**Safety gates:**
- Calendar: confirmation before creating/deleting events
- Voice calls (ElevenLabs): explicit approval per call
- WhatsApp/Telegram: template messages, opt-in

---

### 5.5 Reporting Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Stripe | Custom skill (skill-connections) | ✅ |
| 2 | Google Sheets | Composio toolkit | ✅ |
| 3 | Gmail | Composio toolkit | ✅ |
| 4 | Slack | Native channel | |
| 5 | Notion | Composio toolkit | |
| 6 | Google Drive | Composio toolkit | |
| 7 | Mixpanel/PostHog | Composio toolkit | |
| 8 | Google Analytics 4 | Composio (Google Super) | |
| 9 | Xero | Composio toolkit | |
| 10 | CoinGecko | Custom SKILL.md | |

**Minimum viable stack:** Stripe + Google Sheets + Gmail (3 integrations)

**Safety gates:**
- Stripe: read-only only
- All financial data: never expose full API keys in reports

---

### 5.6 Monitoring Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Firecrawl MCP | MCP | ✅ |
| 2 | Tavily MCP | MCP | ✅ |
| 3 | Slack | Native channel | ✅ |
| 4 | Gmail | Composio toolkit | |
| 5 | Telegram | Native channel | |
| 6 | Notion | Composio toolkit | |
| 7 | Google Sheets | Composio toolkit | |
| 8 | Google Drive | Composio toolkit | |
| 9 | Google Calendar | Composio toolkit | |
| 10 | Linear | Custom skill (skill-connections) | |
| 11 | Discord | Native channel | |
| 12 | PDF Extraction | Custom SKILL.md / Firecrawl | |

**Minimum viable stack:** Firecrawl + Tavily + Slack (3 integrations)

---

### 5.7 HubSpot CRM Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | HubSpot | Composio or custom skill | ✅ |
| 2 | Slack | Native channel | |
| 3 | Gmail | Composio toolkit | |
| 4 | Google Calendar | Composio toolkit | |
| 5 | Notion | Composio toolkit | |
| 6 | Tavily MCP | MCP | |

**Minimum viable stack:** HubSpot (1 integration)

**Safety gates:**
- Read-only CRM access first
- Confirm before creating/updating/deleting CRM records
- Pipeline stage changes require confirmation

---

### 5.8 Crypto Trading Agent

**Required integrations (install order):**

| Order | Integration | Path | Minimum Viable? |
|---|---|---|---|
| 1 | Bankr | ClawHub skill | ✅ |
| 2 | Bankr Signals | ClawHub skill | ✅ |
| 3 | Tavily MCP | MCP | ✅ |
| 4 | Firecrawl MCP | MCP | |
| 5 | QuickNode | Custom/ClawHub skill | |
| 6 | Slack | Native channel | |
| 7 | Notion | Composio toolkit | |
| 8 | Google Sheets | Composio toolkit | |
| 9 | Helixa | ClawHub search | |
| 10 | Neynar | Custom SKILL.md | |

**Minimum viable stack:** Bankr + Bankr Signals + Tavily (3 integrations)

**Safety gates:** **MOST CRITICAL OF ALL USE CASES**
- Paper trading mode by default — no live execution
- Every live trade requires explicit confirmation
- Max position size, daily loss limit, allowed token whitelist
- No leverage without explicit opt-in
- Mandatory stop-loss on every position
- Complete trade log with timestamps
- Kill switch to disable all trading

---

## 6. Missing or Weakly Verified Integrations

| Integration | Status | Issue | Recommended Action |
|---|---|---|---|
| **PostFast** | ⚠️ Unverified | Referenced in guides but no confirmed ClawHub page or docs | Search ClawHub; if not found, use Zernio as primary |
| **Post Bridge** | ⚠️ Unverified | Same as PostFast | Search ClawHub; fallback to Zernio |
| **Humanizer** | ⚠️ Unverified | Only 2 mentions, no provider identified | Research or drop from required list |
| **Unified.to** | ⚠️ Unverified | CRM aggregator, unclear if MCP/skill exists | Build custom SKILL.md or use per-CRM Composio toolkits |
| **QuickNode** | ⚠️ Unverified | No confirmed mawaDao Agent integration | Search ClawHub; else custom SKILL.md wrapping JSON-RPC |
| **WooCommerce** | ❌ No integration | No mawaDao Agent/Composio/MCP integration found | Custom SKILL.md wrapping WooCommerce REST API v3 |
| **Google Analytics 4** | ⚠️ Indirect | Available via Composio "Google Super" toolkit | Verify Google Super includes GA4 Data API |
| **PDF Extraction** | ⚠️ Unclear | No dedicated MCP/skill found | Use Firecrawl extract for web PDFs; custom skill for local PDFs |
| **CoinGecko** | ❌ No integration | Simple REST API, no integration exists | Custom SKILL.md (trivial — public API, no auth for basic) |
| **Eventbrite** | ⚠️ Unverified | No confirmed integration | Custom SKILL.md |
| **Luma** | ⚠️ Unverified | No confirmed integration | Custom SKILL.md |
| **Facebook Messenger** | ⚠️ Complex | Requires Meta app review, page tokens | Custom plugin; consider WhatsApp instead |
| **Helixa** | ⚠️ Unverified | Optional crypto agent identity | Search ClawHub |
| **Neynar** | ⚠️ Unverified | Farcaster protocol access | Custom SKILL.md |
| **Composio plugin itself** | ⚠️ Not yet installed | No Composio references in codebase | Need to install and configure |

**Next research steps:**
1. Run `openclaw skills search "postfast"` / `"post-bridge"` / `"quicknode"` / `"helixa"` to verify ClawHub availability
2. Verify Composio plugin installation for mawaDao Agent
3. Test Composio Google Super toolkit for GA4 Data API coverage
4. Build custom SKILL.md for: WooCommerce, CoinGecko, PDF extraction

---

## 7. Standard Custom Skill Template

Use this template when building a custom SKILL.md for integrations that have no existing path:

```markdown
---
name: my-custom-skill
description: Brief description of what this skill does
metadata:
  openclaw:
    emoji: "🔧"
    skillKey: my_custom_skill
    primaryEnv: MY_API_KEY
    homepage: https://provider.com
    requires:
      env:
        - MY_API_KEY
    install:
      - type: npm
        package: my-sdk-package
---

# My Custom Skill

## Overview
This skill enables [functionality] via the [Provider] API.

## Setup

### Prerequisites
1. Create an account at https://provider.com
2. Generate an API key at https://provider.com/settings/api

### Configuration
Set the following environment variable:
```
MY_API_KEY=your_api_key_here
```

### Installation
```bash
openclaw skills install my-custom-skill
```

## Capabilities

### Action 1: [Read Data]
- **Input:** query parameters
- **Output:** structured data
- **Example:** "Get all items from my account"

### Action 2: [Write Data]
- **Input:** data payload
- **Output:** confirmation
- **Example:** "Create a new item with name X"
- **⚠️ Safety:** Requires confirmation before execution

## API Reference

### Base URL
`https://api.provider.com/v1`

### Authentication
Bearer token in Authorization header:
```
Authorization: Bearer MY_API_KEY
```

### Endpoints Used
| Method | Path | Purpose |
|---|---|---|
| GET | /items | List items |
| POST | /items | Create item |
| GET | /items/:id | Get item |
| PUT | /items/:id | Update item |

## Troubleshooting
- "401 Unauthorized": Check your API key
- "429 Rate Limit": Wait and retry, or upgrade plan
- "API key not set": Add MY_API_KEY to ~/.openclaw/.env

## References
- Official API docs: https://provider.com/docs/api
- SDK: https://github.com/provider/sdk
```

### Helper files structure:
```
skills/my-custom-skill/
├── SKILL.md          # Main skill definition
├── references/       # API docs, examples, schemas
│   ├── api-spec.md
│   └── examples.md
└── scripts/          # Optional helper scripts
    └── validate.sh
```

---

## 8. Operator Runbook

### 8.1 Install Commands Reference

```bash
# ── MCP Servers ──────────────────────────────────────────────
# Tavily (research/search)
npx -y tavily-mcp@latest
# ENV: TAVILY_API_KEY=tvly-xxx
# Remote: https://mcp.tavily.com/mcp/?tavilyApiKey=YOUR_KEY

# Firecrawl (scraping/extraction)
npx -y firecrawl-mcp
# ENV: FIRECRAWL_API_KEY=fc-xxx

# ── ClawHub Skills ───────────────────────────────────────────
openclaw skills install mikipalet/zernio-api   # Social media
openclaw skills install bankr                  # Crypto wallet/trading
openclaw skills install bankr-signals          # Crypto signals

# ── Composio Plugin ──────────────────────────────────────────
openclaw plugins install composio
# Config: plugins.entries.composio.config.apiKey = "your-composio-key"
# Restart required after install

# ── Verify ClawHub availability ──────────────────────────────
openclaw skills search "postfast"
openclaw skills search "post-bridge"
openclaw skills search "quicknode"
openclaw skills search "helixa"
```

### 8.2 Restart Behavior

| Change | Restart Required? |
|---|---|
| New env var in `.env` | New session only |
| Plugin install/config change | Gateway restart |
| Skill install via ClawHub | New session (auto-detected) |
| MCP server URL change | New session |
| Channel config change | Gateway restart |
| skill-connections.ts update | Frontend redeploy |

### 8.3 Verification Prompts

After installing each integration, test with these prompts:

| Integration | Test Prompt |
|---|---|
| Tavily | "Search for the latest mawaDao Agent release notes" |
| Firecrawl | "Scrape https://example.com and summarize the content" |
| Slack channel | "Send a test message to #general" |
| Gmail | "Draft an email to test@example.com saying hello" |
| Google Calendar | "What meetings do I have tomorrow?" |
| Google Sheets | "Read the first row from spreadsheet ID xxx" |
| Notion | "List my recent Notion pages" |
| HubSpot | "Search for contacts with email domain example.com" |
| Shopify | "List the 5 most recent orders" |
| Stripe | "Show this month's total revenue" |
| Zernio | "Draft a tweet about our new feature" |
| Bankr | "Show my portfolio balance" |

### 8.4 Update Strategy

```bash
# Update all ClawHub skills
openclaw skills update --all

# Update specific MCP servers
npm update -g firecrawl-mcp tavily-mcp

# Check for Composio toolkit updates
# (Managed by Composio — automatic)
```

### 8.5 Troubleshooting Strategy

1. **Skill not found:** Run `openclaw skills search "<name>"` to verify ClawHub availability
2. **API key errors (401/403):** Check env vars in `~/.openclaw/.env`, verify key at provider dashboard
3. **Rate limits (429):** Reduce request frequency, check provider plan limits, enable retry config
4. **MCP connection failed:** Verify `mcporter list`, check network, try `npx -y <package>@latest` for updates
5. **Composio auth expired:** Re-authenticate via Composio flow in chat or settings
6. **Channel not responding:** Check gateway config YAML, verify bot token, restart gateway
7. **Permission denied:** Check API token scopes (Slack bot scopes, HubSpot Private App scopes, Shopify Admin permissions)

### 8.6 How to Fetch More Docs When Stuck

1. **Read SKILL.md:** `cat ~/.openclaw/skills/<skill-name>/SKILL.md`
2. **Check references:** `ls ~/.openclaw/skills/<skill-name>/references/`
3. **Provider docs:** Visit the provider's official API documentation
4. **ClawHub page:** `https://clawhub.ai/<publisher>/<skill-name>`
5. **Composio toolkit page:** `https://composio.dev/toolkits/<toolkit-name>`
6. **MCP server repo:** Check GitHub for README and examples
7. **mawaDao Agent docs:** Skills creation, plugin development, channel configuration
8. **Source code:** Inspect the skill's SKILL.md frontmatter for `requires`, `install`, and `config` keys
9. **Community:** mawaDao Agent Discord, ClawHub discussions

---

## Appendix A: Credential Summary

| Integration | Env Variable | Where to Get | Stored In |
|---|---|---|---|
| Tavily | `TAVILY_API_KEY` | https://app.tavily.com/home | env / skill-connections |
| Firecrawl | `FIRECRAWL_API_KEY` | https://www.firecrawl.dev/app/api-keys | env / skill-connections |
| Slack | `SLACK_BOT_TOKEN` | https://api.slack.com/apps | skill-connections.ts ✅ |
| Discord | `DISCORD_BOT_TOKEN` | https://discord.com/developers/applications | skill-connections.ts ✅ |
| Telegram | `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | skill-connections.ts ✅ |
| Gmail | OAuth | Composio | Composio managed |
| Google Calendar | OAuth | Composio | Composio managed |
| Google Sheets | OAuth | Composio | Composio managed |
| Google Drive | OAuth | Composio | Composio managed |
| Notion | `NOTION_API_KEY` | https://www.notion.so/my-integrations | skill-connections.ts ✅ |
| HubSpot | `HUBSPOT_ACCESS_TOKEN` | https://app.hubspot.com/private-apps | skill-connections.ts ✅ |
| Stripe | `STRIPE_SECRET_KEY` | https://dashboard.stripe.com/apikeys | skill-connections.ts ✅ |
| Shopify | `SHOPIFY_ACCESS_TOKEN` + `SHOPIFY_SHOP_DOMAIN` | Shopify Partners | skill-connections.ts ✅ |
| Linear | `LINEAR_API_KEY` | https://linear.app/settings/api | skill-connections.ts ✅ |
| ElevenLabs | `ELEVENLABS_API_KEY` | https://elevenlabs.io/app/settings/api-keys | skill-connections.ts ✅ |
| Zernio | `ZERNIO_API_KEY` | https://zernio.com/dashboard/api-keys | env |
| Bankr | Bankr API key | Bankr dashboard | env |
| QuickNode | QuickNode API key | https://www.quicknode.com/dashboard | env |
| Brave (web search) | `BRAVE_API_KEY` | https://api.search.brave.com/ | skill-connections.ts ✅ |
| Composio | Composio API key | https://platform.composio.dev/ | plugin config |
