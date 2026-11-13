# eve Content Agent Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Content assistant built on [eve](https://eve.dev), the open-source agent framework.

Writers tag the agent on  Slack and it drafts blog posts, LinkedIn and X posts, release notes, and newsletters in your house voice, pulling source material from Notion and adding approved pieces to it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-content-agent-template&repository-name=eve-content-agent-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-content-agent-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%2C%7B%22type%22%3A%22mcp.notion.com%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## How it works

- **Lives in Slack.** Answers @mentions and DMs, replies in threads, and renders approvals as
  buttons.
- **Writes in your voice.** One editable style skill per surface (blog, LinkedIn, X, release
  notes, newsletter), enforced by a style check: a deterministic banned-words pass, a decision
  model for the judgment rules, and a reviewer fallback when the decision model is unsure.
- **Grounded in Notion.** Each writer signs in to their own Notion through Vercel Connect, so
  drafts are created as the real person with their own permissions, with no shared secret — and
  page creation pauses for the writer's approval before it runs.
- **Stores files in Vercel Blob.** Export drafts, save images and attachments, and read them
  back, authenticated by the project's OIDC token.

## Quick start with an AI coding agent

If you're working with an AI coding agent like Claude Code or Cursor, you can use this prompt to have it help you with building your agent:

```text
I want to build a Slack agent with the eve framework, using the eve content agent template at https://github.com/vercel-labs/eve-content-agent-template. Read the repository's README.md, AGENTS.md, and ARCHITECTURE.md and follow them. They cover deploying the template, building with eve, how everything works overall, and more.
```
> Explore other prompts for building apps and agents in the [prompt library](https://vercel.com/kb/prompts).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=eve-content-agent-template&repository-name=eve-content-agent-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-content-agent-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%2C%7B%22type%22%3A%22mcp.notion.com%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

Deploying with the button provisions everything the agent needs and wires it up for you:

- a **Slack** connector (sets `SLACK_CONNECTOR`, with the event trigger pointed at
  `/eve/v1/slack`),
- a **Notion** connector (sets `NOTION_CONNECTOR`),
- a private **Vercel Blob** store for the asset tools and writer preferences.

Once deployed, @mention the bot in your Slack workspace to start drafting.

## Tech stack

| Layer | Technology |
| --- | --- |
| Agent framework | [eve](https://eve.dev) |
| Language | TypeScript (strict, ESM) |
| Chat surface | Slack, via [Vercel Connect](https://vercel.com/docs/connect) |
| Source & publishing | Notion (MCP), user-scoped OAuth via [Vercel Connect](https://vercel.com/docs/connect) |
| File storage | [Vercel Blob](https://vercel.com/docs/vercel-blob) |
| Model access | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) |
| Sandbox | [Vercel Sandbox](https://vercel.com/docs/sandbox) |
| Lint & format | [Ultracite](https://www.ultracite.ai/) (Biome) |

**Zero static keys.**
Authentication runs entirely on [Vercel Connect](https://vercel.com/docs/connect)
(Slack and Notion) and [Vercel OIDC](https://vercel.com/docs/oidc) (Vercel Blob and AI
Gateway). There are no API keys or client secrets to manage in code or `.env` files: Notion is
authorized per writer in the browser, and Blob and the model authenticate with the project's
OIDC token.

## What's inside

```text
agent/
  agent.ts                  # model configuration
  instructions.md           # the agent's behavior
  channels/slack.ts         # Slack surface (Vercel Connect credentials)
  channels/eve.ts           # default HTTP channel (dev TUI, evals)
  connections/notion.ts     # Notion workspace, user-scoped OAuth; page creation requires approval
  sandbox.ts                # Vercel Sandbox environment
  memory/preferences.ts     # per-writer style preferences (eve file memory)
  subagents/
    researcher/             # fresh-context web researcher (own session, web tools only)
    reviewer/               # fresh-context draft reviewer (own session); pulls its rubric via a tool
  tools/
    research.ts             # runs the researcher subagent; returns cited findings + gaps
    review.ts               # runs the reviewer subagent; returns a verdict + issues
    check_style.ts          # banned-words pass + decision-model rules + reviewer fallback
    upload_asset.ts         # Vercel Blob: store text or binary content
    list_assets.ts          # Vercel Blob: browse stored assets
    get_asset_info.ts       # Vercel Blob: metadata without downloading
    download_asset.ts       # Vercel Blob: read a stored file back
    delete_asset.ts         # Vercel Blob: delete (requires approval)
    detect_surface.ts       # decision model picks the surface, or says to ask the writer
    bash.ts, write_file.ts, edit_file.ts  # disable built-in tools the agent doesn't need
  lib/
    reserved-paths.ts       # Blob prefixes the asset tools refuse (writer memory)
    mock-model.ts           # mock models for the offline evals (EVE_MOCK_MODEL=1)
    surfaces.generated.ts   # generated SURFACES enum (skill folders are the source of truth)
    banned-words.generated.ts # generated banned-words lists for check_style
    banned-words.ts         # literal, ReDoS-safe banned-words matcher
    models.ts               # Gateway model ids (root, reviewer, research pair, decision model)
    review-schema.ts        # reviewer verdict schema shared by review and check_style
  skills/                   # one style skill per surface
    blog-style/             # + best-practices.md and format-specs.md
    linkedin-style/         # + best-practices.md and post-specs.md
    x-style/                # X (Twitter) — + best-practices.md and post-specs.md
    release-notes-style/
    newsletter-style/
shared-references/          # house-wide writing rules (source of truth), synced into each skill
  ai-phrases-to-avoid.md
  plain-english-alternatives.md
scripts/
  sync-shared.mjs           # syncs shared refs into skills; generates SURFACES, banned words + reviewer rubric (pnpm sync:shared)
```

## Local development

Link the project you deployed (or a fresh one) and pull its environment:

```bash
vercel link
vercel env pull
```

Then run the development server and link a model provider with `/model` in the TUI:

```bash
pnpm dev
```

You can chat with the agent directly in the dev TUI to test the drafting, style-check, Notion,
and Blob flows. The Slack surface itself only runs against a deployment. Ship changes with:

```bash
eve deploy
```

### Evals

```bash
pnpm eval:offline   # mock models, no model calls, a few seconds
pnpm eval           # real models through the AI Gateway
```

The offline suite (`evals/offline/`) checks the agent's tools, approvals, memory, and subagent
plumbing without calling a model. The live suite (`evals/live/`) covers the style check, surface
detection, research, and a draft-quality case graded by a decision model.

### Linting and formatting

This project uses [Ultracite](https://www.ultracite.ai/) (a [Biome](https://biomejs.dev/)
preset) for linting and formatting:

```bash
pnpm check   # check formatting and lint rules
pnpm fix     # auto-fix what is fixable
```

### Setting up the connectors by hand

The Deploy button provisions these for you. To set them up manually (for a project you didn't
create with the button), use the [Vercel CLI](https://vercel.com/docs/cli):

```bash
# Notion connector, using Notion's MCP server (set NOTION_CONNECTOR to the printed UID)
vercel connect create notion --connection-method mcp --name notion

# Slack connector (note the UID, e.g. slack/<name> -> SLACK_CONNECTOR), then point its
# event trigger at the route the agent serves
vercel connect create slack --name <name> --triggers
vercel connect attach slack/<name> --triggers --trigger-path /eve/v1/slack

# Blob store, connected to the project for all environments
vercel blob create-store <name> --access private --yes
```

## Customizing

- **Voice:** edit the per-surface skills in `agent/skills/*/SKILL.md`, and the
  `references/banned-words.json` each one lints against (run `pnpm sync:shared` after editing it,
  so `check_style` picks up the change). Add a new surface by adding a new
  `<surface>-style` skill folder and running `pnpm sync:shared` — the `SURFACES` enum shared by
  `check_style` and the reviewer is generated from the folders, so there's no list to edit.
- **House-wide rules:** edit the shared writing rules in `shared-references/` (the source of
  truth), then run `pnpm sync:shared`. It copies them into every skill's `references/` and
  regenerates the managed `## Shared references` section in each `SKILL.md` (a skill's own
  `## References` section is left alone), and regenerates `agent/lib/surfaces.generated.ts`,
  `agent/lib/banned-words.generated.ts`, and the reviewer's rubric module. The sync also runs automatically on `pnpm dev` and `pnpm build`.
  Never edit the synced copies or generated files directly.
- **Behavior:** edit `agent/instructions.md`.
- **Models:** edit the ids in `agent/lib/models.ts`. The researcher picks between two models per
  call: a decision model reads the research request and routes deep work to one and routine
  lookups to the other (`agent/subagents/researcher/agent.ts`).
- **Tools:** add or change tools in `agent/tools/`. The filename is the tool name.

The agent auto-updates as you edit these files.

## Learn more

- [eve on Vercel documentation](https://vercel.com/docs/frameworks/agents/eve)
- [Vercel Connect documentation](https://vercel.com/docs/connect)
- [Vercel Blob documentation](https://vercel.com/docs/vercel-blob)

## Related templates

- [eve Agent with Python](https://vercel.com/templates/eve/eve-agent-with-python)
- [eve Data Analyst](https://vercel.com/templates/eve/eve-data-analyst)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
