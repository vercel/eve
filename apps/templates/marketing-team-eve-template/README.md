# Marketing Team eve Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Run a team of marketing agents built on [eve](https://eve.dev), the open-source agent framework. You bring work to a team lead: a launch to plan, posts to write, or a page that isn't converting. The lead briefs the right specialist and hands back what they produced.

You talk to it in Slack or a terminal. It delivers real work in the tools you already use: blog drafts in Notion, social posts in Typefully, email campaigns in Resend.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=marketing-team-eve-template&repository-name=marketing-team-eve-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fmarketing-team-eve-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22notion%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%2C%7B%22type%22%3A%22resend%22%2C%22env%22%3A%22RESEND_CONNECTOR%22%7D%2C%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&env=TYPEFULLY_API_KEY&envDescription=API%20key%20for%20the%20Typefully%20MCP%20server%2C%20used%20to%20read%20and%20write%20social%20drafts)

## What using it looks like

> **You:** We're launching workspace templates next Thursday. Can you draft the announcement posts?
>
> **Lead:** On it. I'll check the brand context and brief the social media coordinator.
>
> **Lead:** Done. Three drafts are in your Typefully queue: an X thread, a LinkedIn post, and a Bluesky post. Nothing is scheduled yet, so review them and tell me when to queue them for launch morning.

Anything irreversible, like sending an email campaign or publishing a scheduled post, pauses for your approval first. You get an approve or deny button in Slack or the terminal before it goes out.

## How it works

- **One lead, five specialists.** The lead loads the brand context, recalls your saved preferences, writes a brief for the right specialist, and hands back what they produce. It never writes deliverables itself.
- **Every brief is self-contained.** Specialists start fresh each time, with no shared conversation history, so the lead's brief carries everything and each specialist reads the brand context itself.
- **Delegation goes one level deep.** Specialists do their own research and edit their own drafts against a written rubric rather than spawning further agents.
- **Nothing irreversible happens without you.** Sends and deletes in Resend, deletes and scheduled publishes in Typefully, and page edits and moves in Notion all wait for your approval. Drafting stays friction-free. The email specialist also only sees 47 of Resend's roughly 85 tools, so account administration is out of reach entirely.
- **Slack pins four starter prompts** in a fresh conversation, one per specialist: sharpen our positioning, write a blog post, draft social posts, review a page's SEO.

### The team

| Specialist                 | Owns                                                                                      | Hands back                                |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| `product-marketer`         | Positioning, messaging, competitive alternatives, and the shared brand context document   | The brand context document itself         |
| `content-marketer`         | Long-form: blog posts, landing pages, case studies, newsletters, docs                     | A Notion page link                        |
| `social-media-coordinator` | Short-form for X, LinkedIn, Threads, Bluesky, and Mastodon, plus the Typefully queue      | Drafts in Typefully                       |
| `seo`                      | Page and site audits, hierarchy and internal linking, JSON-LD schema, templated page sets | Recommendations, long audits as artifacts |
| `email`                    | Reworking existing copy for the inbox, then building, targeting, and sending in Resend    | A Resend campaign link                    |

The team works from one shared document: the **brand context document**, a short file describing what your product is, who it's for, and what the team claims about it. The product marketer maintains it; every other specialist reads it at the start of a task. Because every specialist depends on it, it has a single owner.

Each specialist has a distinct job: the product marketer decides what the team claims, the content marketer writes long-form copy, `seo` decides which pages should exist, and `social-media-coordinator` and `email` publish to an audience. Newsletters route through two of them: the content marketer writes the prose, then the email specialist adapts it for the inbox and sends it through Resend, so newsletters still get the content marketer's planning and editing passes.

The full approval matrix, the credential model, and the reasoning behind each boundary live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Asset downloads accept up to 1 MiB of text bytes or 768 KiB of binary bytes before base64 encoding. Split larger files before downloading. Asset listings return one page at a time: when `hasMore` is true, pass the returned `cursor` with the same prefix, even when reserved documents leave the current page empty.

## Quick start with an AI coding agent

If you're working with an AI coding agent like Claude Code or Cursor, you can use this prompt to have it help you with building your agent:

```text
I want to build a team of marketing agents with the eve framework, using the marketing team template at https://github.com/vercel-labs/marketing-team-eve-template. Read the repository's README.md, AGENTS.md, and docs/ARCHITECTURE.md and follow them. They cover deploying the template, building with eve, how everything works overall, and more.
```

> Explore other prompts for building apps and agents in the [prompt library](https://vercel.com/kb/prompts).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=marketing-team-eve-template&repository-name=marketing-team-eve-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fmarketing-team-eve-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22notion%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%2C%7B%22type%22%3A%22resend%22%2C%22env%22%3A%22RESEND_CONNECTOR%22%7D%2C%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&env=TYPEFULLY_API_KEY&envDescription=API%20key%20for%20the%20Typefully%20MCP%20server%2C%20used%20to%20read%20and%20write%20social%20drafts)

The one-click deploy provisions and wires up everything the team needs:

| Provisioned                      | Sets                |
| -------------------------------- | ------------------- |
| Notion connector                 | `NOTION_CONNECTOR`  |
| Resend connector                 | `RESEND_CONNECTOR`  |
| Slack connector                  | `SLACK_CONNECTOR`   |
| Private Vercel Blob store        | Blob credentials    |
| Prompt for the Typefully API key | `TYPEFULLY_API_KEY` |

Once deployed, @mention the bot in your Slack workspace and tell it what you're working on.

### Before your first email campaign

Verify a sending domain and create at least one segment in the [Resend dashboard](https://resend.com/domains). The agent sees your verified domains and segments and picks from them, but it cannot create a domain or verify DNS for you.

## Tech stack

| Layer                             | Technology                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Agent framework                   | [eve](https://eve.dev)                                                         |
| Language                          | TypeScript (strict, ESM), Node 24.x                                            |
| Chat surfaces                     | Slack via Vercel Connect, the eve dev TUI                                      |
| Long-form deliverables and briefs | Notion (MCP)                                                                   |
| Social publishing                 | Typefully (MCP)                                                                |
| Email campaigns                   | Resend (MCP)                                                                   |
| Shared state and files            | [Vercel Blob](https://vercel.com/docs/vercel-blob), one private store          |
| Per-person preferences            | eve file memory, in the same store                                             |
| Model access                      | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)                        |
| Skill reference files             | [Vercel Sandbox](https://vercel.com/docs/sandbox)                              |
| Lint and format                   | [Ultracite](https://www.ultracite.ai/), a [Biome](https://biomejs.dev/) preset |

**One static key.** Authentication runs on [Vercel Connect](https://vercel.com/docs/connect) (Slack, Notion, and Resend) and [Vercel OIDC](https://vercel.com/docs/oidc) (Vercel Blob and AI Gateway). Notion and Resend are authorized per person in the browser, so the agent acts as the real person with their own permissions. The one exception is `TYPEFULLY_API_KEY`, a workspace API key read from the environment, because Typefully's MCP server authenticates that way.

## What's inside

```text
agent/
  agent.ts                  # the lead: model, no built-in tools, the memory-removal gate
  instructions.md           # the lead's behavior: ground, route, hand back
  channels/                 # Slack (Vercel Connect) and the default HTTP channel (dev TUI, evals)
  connections/notion.ts     # Notion workspace, user-scoped OAuth
  memory/preferences.ts     # per-person standing preferences (eve file memory)
  tools/                    # brand context, artifact reader, and the workflow tool
  subagents/
    product-marketer/       # positioning, messaging, and the shared brand context document
    content-marketer/       # long-form, written into Notion
    social-media-coordinator/ # short-form and the Typefully queue
    seo/                    # audits, site architecture, JSON-LD schema
    email/                  # adapts copy for the inbox, then builds and sends in Resend
  lib/                      # shared factories and helpers, one folder per domain
evals/
  offline/                  # mock models: approvals, memory, delegation, pure helpers
  live/                     # real models: routing and the decision-model tools
```

Each specialist carries its own `instructions.md`, `skills/`, `tools/`, `connections/`, and `sandbox.ts`. The full annotated tree is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Local development

Link the project you deployed, or a fresh one, and pull its environment:

```bash
vercel link
vercel env pull
pnpm dev          # /login connects a model provider if none is found; /model switches models
```

| Command                   | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                | eve dev TUI                                                          |
| `pnpm validate`           | Lint, typecheck, discovery diagnostics, and the offline evals in one |
| `pnpm eval:offline`       | Offline evals on mock models: no model calls, a few seconds          |
| `pnpm eval`               | Live evals on real models (needs AI Gateway credentials)             |
| `pnpm check` / `pnpm fix` | Ultracite check and auto-fix                                         |
| `pnpm typecheck`          | TypeScript, no emit                                                  |
| `npx eve info`            | Print every discovered tool, skill, connection, and subagent         |
| `eve deploy`              | Ship to production                                                   |

You can chat with the lead directly in the dev TUI to test routing and each specialist. The Slack surface itself only runs against a deployment.

### Evals

```bash
pnpm eval:offline   # mock models, no model calls, a few seconds
pnpm eval           # real models through the AI Gateway
```

The offline suite (`evals/offline/`) checks approvals, memory, delegation, and the pure helpers (Slack identity, reserved Blob prefixes, banned words, pre-send patterns) without calling a model. The live suite (`evals/live/`) is three narrow cases: the lead's routing, and one per decision-model tool asserting that the decision model actually answered. It needs AI Gateway credentials whose team allows the decision model's provider.

### Linting and formatting

This project uses [Ultracite](https://www.ultracite.ai/) (a [Biome](https://biomejs.dev/) preset) for linting and formatting:

```bash
pnpm check   # check formatting and lint rules
pnpm fix     # auto-fix what is fixable
```

### Setting up the connectors by hand

The Deploy button provisions these for you. To set them up manually, for a project you didn't create with the button, use the [Vercel CLI](https://vercel.com/docs/cli). Each `create` command prints the connector's UID; set the matching variable to that printed UID.

```bash
# Notion connector, using Notion's MCP server (set NOTION_CONNECTOR to the printed UID)
vercel connect create notion --connection-method mcp --name <name>

# Resend connector (set RESEND_CONNECTOR to the printed UID)
vercel connect create resend --name <name>

# Slack connector (set SLACK_CONNECTOR to the printed UID), then point its event trigger at
# the route the agent serves
vercel connect create slack --name <name> --triggers
vercel connect attach slack/<name> --triggers --trigger-path /eve/v1/slack

# Private Blob store, connected to the project for all environments
vercel blob create-store <name> --access private --yes

# The Typefully workspace API key, the one static credential
vercel env add TYPEFULLY_API_KEY
```

## Customizing

The agent auto-updates as you edit these files. [`docs/CUSTOMIZING.md`](./docs/CUSTOMIZING.md) is the full walkthrough, with recipes for adding a specialist, skill, tool, or connection.

| To change                                | Edit                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Who is on the team                       | Add a directory under `agent/subagents/`; its `description` is all the lead sees when routing               |
| The lead's behavior                      | `agent/instructions.md`                                                                                     |
| A specialist's craft                     | Its `instructions.md` and `skills/`                                                                         |
| Voice and banned words                   | `references/banned-words.json` in each `<surface>-style` skill                                              |
| Approval gates                           | The tool lists in `agent/lib/notion/connection.ts`, `connections/typefully.ts`, and `connections/resend.ts` |
| The decision model's thresholds          | `agent/lib/decisions/config.ts`                                                                             |
| What the email agent can reach           | `ALLOWED_TOOLS` in `connections/resend.ts`                                                                  |
| Models                                   | `agent/lib/models/config.ts`, or `/model` in the TUI                                                        |
| Which bots may act for a person in Slack | `SLACK_ON_BEHALF_OF_BOTS` (empty by default)                                                                |

Specialists don't have to live in this repo. eve's [remote agents](https://eve.dev/docs/guides/remote-agents) let the lead delegate to an agent in its own deployment, with its own skills, connections, and release cycle:

```ts
// agent/subagents/paid_ads.ts
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: () =>
    process.env.PAID_ADS_AGENT_URL ?? "https://your-paid-ads-agent.vercel.app",
  description:
    "Plan and write paid search and social ads: audience, offer, and the copy variants to test. " +
    "Pass the campaign goal, the audience, the budget, and any brand constraints in the message.",
  auth: vercelOidc(),
});
```

Set `PAID_ADS_AGENT_URL`, and the lead picks the specialist up from its `description` exactly as it does the local ones. Useful when a specialist needs credentials or a release cycle you'd rather keep out of this repo, such as ad platform access.

## Learn more

- [eve on Vercel documentation](https://vercel.com/docs/frameworks/agents/eve)
- [Vercel Connect documentation](https://vercel.com/docs/connect)
- [Vercel Blob documentation](https://vercel.com/docs/vercel-blob)

## Related templates

- [eve Content Agent](https://vercel.com/templates/eve/eve-content-agent)
- [eve Agent with Python](https://vercel.com/templates/eve/eve-agent-with-python)
- [eve Data Analyst](https://vercel.com/templates/eve/eve-data-analyst)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
