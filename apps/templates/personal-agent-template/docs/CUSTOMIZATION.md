# Customization Guide

> Back to [README](../README.md) | See also: [Environment](./ENVIRONMENT.md), [Architecture](./ARCHITECTURE.md)

Personal Agent Template ships with **V** as the example persona. This guide covers how to fork and make it yours.

## 1. Rename your agent

### Branding metadata

Edit [`shared/agent.ts`](../shared/agent.ts):

```typescript
export const agent = {
  name: "My Agent",
  slug: "my-agent",
  tagline: "Your personal AI assistant",
  description: "Remembers your context across conversations and channels.",
  avatar: {
    icon: "i-lucide-bot", // or any Lucide icon
  },
} as const;
```

Also update site metadata in [`app/app.config.ts`](../app/app.config.ts) (`site.name`, `site.title`, `site.description`, `site.tagline`).

Replace branding assets in [`public/`](../public/):

| File          | Purpose                           |
| ------------- | --------------------------------- |
| `banner.png`  | README hero banner                |
| `og.png`      | Open Graph / Twitter card preview |
| `favicon.ico` | Browser tab icon                  |

Use your own design files when ready — keep them in `public/` and update `site.ogImage` in [`app/app.config.ts`](../app/app.config.ts) if the path changes.

This name appears in the navbar, settings, and integration cards.

### Persona and behavior

Edit [`agent/lib/base-instructions.ts`](../agent/lib/base-instructions.ts) — system prompt, tone, tool usage rules, memory behavior.

Search the codebase for `V` to update remaining UI copy in Vue components.

### Package metadata

Update [`package.json`](../package.json) `name`, `description`, and `repository` if you publish your fork.

## 2. Change the AI model

Edit [`agent/agent.ts`](../agent/agent.ts):

```typescript
export default defineAgent({
  model: "anthropic/claude-sonnet-4.6", // change provider/model
  // ...
});
```

See Eve docs for supported models and provider options.

## 3. Memory categories

Categories are defined in [`shared/types/memory.ts`](../shared/types/memory.ts):

- `MEMORY_CATEGORIES` — enum values
- `MEMORY_CATEGORY_LABELS` — UI labels
- `MEMORY_CATEGORY_HEADERS` — import parser aliases

If you add or rename categories, also update:

- [`shared/memory/export-prompt.ts`](../shared/memory/export-prompt.ts) — ChatGPT export prompt
- [`agent/tools/save_memory.ts`](../agent/tools/save_memory.ts) — imports categories from shared types

Each category stores **one prose block**. Saves replace the entire block, not partial deltas.

## 4. Add a tool

1. Create `agent/tools/my-tool.ts` using Eve's `defineTool`
2. Register it in Eve's tool discovery (auto-loaded from `agent/tools/` by convention — verify in Eve docs)
3. Add a UI component in `app/components/chat/tool/` if the tool needs custom rendering
4. Wire the component in [`app/components/chat/message/MessageContentEve.vue`](../app/components/chat/message/MessageContentEve.vue)

See existing tools: [`agent/tools/weather.ts`](../agent/tools/weather.ts), [`agent/tools/save_memory.ts`](../agent/tools/save_memory.ts).

## 5. Add a skill

Skills are markdown files in [`agent/skills/`](../agent/skills/). See [`daily-summary.md`](../agent/skills/daily-summary.md) for an example. Reference skills from home quick actions in [`app/pages/index.vue`](../app/pages/index.vue).

## 6. Integrations

### GitHub

Uses Vercel Connect OAuth and [@github-tools/sdk/eve](https://github-tools.com/frameworks/eve). Connector UID: [`shared/connect.ts`](../shared/connect.ts) (`GITHUB_CONNECTOR`), registry: [`server/connectors.ts`](../server/connectors.ts), tools: [`agent/tools/github.ts`](../agent/tools/github.ts).

1. Create a GitHub connector in Vercel Connect:

   ```bash
   vercel connect create github --name personal-agent
   vercel connect attach github/personal-agent
   ```

2. Update `GITHUB_CONNECTOR` in [`shared/connect.ts`](../shared/connect.ts) if it differs from `vercel connect list`
3. Open **Settings → Integrations** and connect
4. Ask about repos, PRs, or issues in chat

### Linear

Uses Vercel Connect MCP (`mcp.linear.app/linear`). Connection logic: [`agent/connections/linear.ts`](../agent/connections/linear.ts).

1. Create a Linear MCP connector in Vercel Connect
2. Open **Settings → Integrations** and connect
3. Ask about issues in chat

### Slack

1. Create a Slack connector in Vercel Connect
2. Replace the slug in [`agent/channels/slack.ts`](../agent/channels/slack.ts):

```typescript
credentials: connectSlackCredentials("slack/your-slug"),
```

3. Connect in **Settings → Integrations**
4. Link accounts: generate a code in the app, then DM `link <code>` to the bot

Slack linking uses the internal API — `INTERNAL_API_SECRET` must be set.

### Sendblue (iMessage)

Reach the agent over iMessage via [Sendblue](https://chat-sdk.dev/adapters/vendor-official/sendblue). Channel logic: [`agent/channels/sendblue.ts`](../agent/channels/sendblue.ts).

1. Create a Sendblue account and copy API credentials + assigned number from the [dashboard](https://dashboard.sendblue.com) (or `@sendblue/cli`: `sendblue setup`, `sendblue show-keys`, `sendblue lines`)
2. Set `SENDBLUE_*` env vars on the **eve** service — see [Environment](./ENVIRONMENT.md#sendblue-imessage-optional)
3. Point the Sendblue receive webhook at `https://<your-domain>/_eve_internal/eve/eve/v1/sendblue/webhook`
4. Users add their E.164 phone number in **Settings → Profile**, then message the Sendblue number from that phone

Phone linking uses the internal API (`GET /api/internal/phone/link`) — `INTERNAL_API_SECRET` must be set.

Tool approvals (`save_memory`) and OAuth prompts are delivered as plain-text iMessage with a link to the web chat — there is no button UI on iMessage.

### Phone number (profile)

Users add an E.164 number on **Profile**. Required for Sendblue/iMessage auth — the inbound sender number must match the linked profile phone.

## 7. Theme the UI

- Global styles: [`app/assets/css/main.css`](../app/assets/css/main.css)
- Nuxt UI config: [`app/app.config.ts`](../app/app.config.ts)
- Layout and navigation: [`app/layouts/default.vue`](../app/layouts/default.vue), [`app/components/Navbar.vue`](../app/components/Navbar.vue)

## 8. Deploy your fork

See [Deploy on Vercel](../README.md#deploy-on-vercel) in the README. Remember:

- Dual services: `web` + `eve` ([`vercel.json`](../vercel.json))
- Same env vars on both services
- Run migrations for production database
