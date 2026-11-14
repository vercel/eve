# Sanity Copilot eve Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Sanity copilot built on [eve](https://eve.dev), the open-source agent framework.

Team members tag the agent on Slack and it works on their Sanity project: querying content with GROQ, shaping schemas, creating and editing drafts, managing releases, and drafting long-form pieces into Notion.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=sanity-copilot-eve-template&repository-name=sanity-copilot-eve-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fsanity-copilot-eve-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%2C%7B%22type%22%3A%22sanity%22%2C%22env%22%3A%22SANITY_CONNECTOR%22%7D%2C%7B%22type%22%3A%22notion%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## How it works

- **Lives in Slack.** Answers @mentions and DMs, replies in threads, and renders approvals as buttons.
- **Works on your Sanity project.** Each user signs in to Sanity through Vercel Connect, so queries and edits run as the real person with their own permissions. Destructive operations (patching, publishing, deploying schemas) pause for approval before they run.
- **Drafts in Notion.** Long-form pieces are created as Notion pages through the same user-scoped sign-in, with page updates and moves gated on approval.
- **Researches and reviews with fresh eyes.** A web researcher returns cited findings for facts the project doesn't hold, and a reviewer checks each finished draft against the writing rubric before it reaches you.
- **Remembers preferences.** Standing preferences such as spelling, tone, or a default dataset are saved per user and applied in later sessions.
- **Stores files in Vercel Blob.** Export drafts, save images and attachments, and read them back, authenticated by the project's OIDC token. The store is private, so an asset's URL identifies it to the agent and is not a link to open in a browser.

## Quick start with an AI coding agent

If you're working with an AI coding agent like Claude Code or Cursor, you can use this prompt to have it help you with building your agent:

```text
I want to build a Slack agent with the eve framework, using the Sanity copilot template at https://github.com/vercel-labs/sanity-copilot-eve-template. Read the repository's README.md, AGENTS.md, and ARCHITECTURE.md and follow them. They cover deploying the template, building with eve, how everything works overall, and more.
```

> Explore other prompts for building apps and agents in the [prompt library](https://vercel.com/kb/prompts).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=sanity-copilot-eve-template&repository-name=sanity-copilot-eve-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fsanity-copilot-eve-template%2Ftree%2Fmain&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%2C%7B%22type%22%3A%22sanity%22%2C%22env%22%3A%22SANITY_CONNECTOR%22%7D%2C%7B%22type%22%3A%22notion%22%2C%22env%22%3A%22NOTION_CONNECTOR%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

Deploying with the button provisions everything the agent needs and wires it up for you:

- a **Slack** connector (sets `SLACK_CONNECTOR`, with the event trigger pointed at `/eve/v1/slack`),
- a **Sanity** connector (sets `SANITY_CONNECTOR`),
- a **Notion** connector (sets `NOTION_CONNECTOR`),
- a private **Vercel Blob** store for the asset tools and user preferences.

Once deployed, @mention the bot in your Slack workspace to start working on your Sanity project.

## Tech stack

| Layer              | Technology                                                                            |
| ------------------ | ------------------------------------------------------------------------------------- |
| Agent framework    | [eve](https://eve.dev)                                                                |
| Language           | TypeScript (strict, ESM)                                                              |
| Chat surface       | Slack, via [Vercel Connect](https://vercel.com/docs/connect)                          |
| Content management | Sanity (MCP), user-scoped OAuth via [Vercel Connect](https://vercel.com/docs/connect) |
| Drafting surface   | Notion (MCP), user-scoped OAuth via [Vercel Connect](https://vercel.com/docs/connect) |
| File storage       | [Vercel Blob](https://vercel.com/docs/vercel-blob)                                    |
| Model access       | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)                               |
| Sandbox            | [Vercel Sandbox](https://vercel.com/docs/sandbox)                                     |
| Lint & format      | [Ultracite](https://www.ultracite.ai/) (Biome)                                        |

**Zero static keys.** Authentication runs entirely on [Vercel Connect](https://vercel.com/docs/connect) (Slack, Sanity, and Notion) and [Vercel OIDC](https://vercel.com/docs/oidc) (Vercel Blob and AI Gateway). There are no API keys or client secrets to manage in code or `.env` files: Sanity and Notion are authorized per user in the browser, and Blob and the model authenticate with the project's OIDC token. The optional [Sanity Context](#sanity-context) connection is the one exception: it uses an organization API token.

## Sanity Context

[Sanity Context](https://www.sanity.io/docs/context/introduction) is an optional, read-only knowledge source. It serves Knowledge Bases built from datasets, websites, and uploaded files over MCP, so the copilot can look up reference material that isn't in the Sanity project or Notion, such as brand guidelines or policy documents. It doesn't replace the Sanity connection, which is the only one that can write.

The connection lives in [`agent/connections/sanity-context.ts`](agent/connections/sanity-context.ts) and is off by default. It turns on when both of these environment variables are set:

| Variable                    | Value                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `SANITY_CONTEXT_MCP_URL`    | The MCP endpoint URL shown in the Context app in the Sanity Dashboard               |
| `SANITY_ORGANIZATION_TOKEN` | An organization API token with the Context Viewer role (project tokens are refused) |

Add them to the linked project with the [Vercel CLI](https://vercel.com/docs/cli/env), then redeploy so the deployment picks them up:

```bash
vercel env add SANITY_CONTEXT_MCP_URL --environment production,preview,development
vercel env add SANITY_ORGANIZATION_TOKEN --environment production,preview --sensitive
eve deploy
```

Each command prompts for the value. To use the connection in `pnpm dev` as well, add the token to the development environment as a regular variable (sensitive values aren't available there) and pull it:

```bash
vercel env add SANITY_ORGANIZATION_TOKEN --environment development
vercel env pull
```

<details>
<summary>How the connection works</summary>

The file returns `null` when either variable is missing, so a default deployment has no Sanity Context connection at all:

```ts
// agent/connections/sanity-context.ts
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

export default defineDynamic(() => {
  const url = process.env.SANITY_CONTEXT_MCP_URL;
  const token = process.env.SANITY_ORGANIZATION_TOKEN;
  if (!(url && token)) {
    return null;
  }
  return defineMcpClientConnection({
    auth: { getToken: () => Promise.resolve({ token }) },
    description:
      "Sanity Context: read-only reference knowledge, such as Knowledge Bases built from " +
      "documents, websites, and files. Look things up here when a task needs reference " +
      "material the Sanity project and Notion don't hold. It cannot create or change content.",
    instanceKey: "sanity-context",
    url,
  });
});
```

- The model reads `description` to decide when to look here, so rewrite it to describe your own content.
- The endpoint is read-only, so none of its tools need approval.
- Every user reads through the same organization token, so everyone sees the same content whatever their own Sanity permissions. Scope what the endpoint serves in the Context app.
- This is the one static credential in the template. Leave the variables unset to stay on Vercel Connect and OIDC only.

</details>

<details>
<summary>Creating an endpoint and token</summary>

1. In the Sanity Dashboard, open the Context app and create an MCP endpoint with a Knowledge Base source, a dataset source, or both. See [Configure an MCP endpoint](https://www.sanity.io/docs/context/configure-mcp). Copy its URL into `SANITY_CONTEXT_MCP_URL`.
2. On the organization's [API tokens page](https://www.sanity.io/manage/org/api/tokens) in Manage, create an API token and give it the Context permission with the Viewer role. Copy it into `SANITY_ORGANIZATION_TOKEN`.

Sanity's guide, [Connect Sanity Context with Vercel eve](https://www.sanity.io/docs/context/connect-vercel-eve), covers the CLI route and troubleshooting. Context needs a Sanity organization with access to it, and the plan sets how many Knowledge Bases you can build.

</details>

## What's inside

```text
agent/
  agent.ts                  # model, compaction, session usage limit
  instructions.md           # the agent's behavior
  channels/slack.ts         # Slack surface (Vercel Connect credentials)
  channels/eve.ts           # default HTTP channel (dev TUI, evals)
  connections/sanity.ts     # Sanity MCP, user-scoped OAuth; destructive tools require approval
  connections/notion.ts     # Notion MCP, user-scoped OAuth; page updates and moves require approval
  connections/sanity-context.ts  # optional read-only Sanity Context endpoint (off unless its env vars are set)
  sandbox.ts                # Vercel Sandbox environment
  memory/preferences.ts     # per-user standing preferences (eve file memory)
  subagents/
    researcher/             # fresh-context web researcher (own session, web tools only)
    reviewer/               # fresh-context draft reviewer (own session, own writing-quality copy)
  tools/
    research.ts             # runs the researcher subagent; returns cited findings + gaps
    review_draft.ts         # runs the reviewer subagent; returns a verdict + issues
    upload_asset.ts         # Vercel Blob: store text or binary content
    list_assets.ts          # Vercel Blob: browse stored assets
    get_asset_info.ts       # Vercel Blob: metadata without downloading
    download_asset.ts       # Vercel Blob: read a stored file back
    delete_asset.ts         # Vercel Blob: delete (requires approval)
    bash.ts, write_file.ts, edit_file.ts  # disable built-in tools the agent doesn't need
  lib/
    models.ts               # Gateway model ids (root, reviewer, research pair, decision model)
    mock-model.ts           # mock models for the offline evals (EVE_MOCK_MODEL=1)
    subagent.ts             # runs one subagent turn and returns its structured result
    review-schema.ts        # reviewer verdict schema
    reserved-paths.ts       # Blob prefixes the asset tools refuse (user memory)
  skills/
    sanity-best-practices/              # schemas, GROQ, releases, framework integrations
    content-modeling-best-practices/    # designing and refactoring content types
    portable-text-conversion/           # converting rich text into Portable Text
    portable-text-serialization/        # rendering Portable Text out to other formats
    seo-aeo-best-practices/             # metadata, structured data, AI-answer readiness
    content-experimentation-best-practices/  # A/B tests and variants
    writing-quality/                    # prose rules for anything written for humans
evals/
  offline/                  # mock models, no model calls
  live/                     # real models through the AI Gateway
shared-references/          # writing rules shared by both writing-quality copies (source of truth)
  ai-phrases-to-avoid.md
  plain-english-alternatives.md
scripts/
  sync-shared.mjs           # syncs shared refs into both writing-quality skills (pnpm sync:shared)
```

Every skill except `writing-quality` comes from Sanity's [Agent Toolkit](https://github.com/sanity-io/agent-toolkit).

## Local development

Link the project you deployed (or a fresh one) and pull its environment:

```bash
vercel link
vercel env pull
```

Then run the development server and connect a model provider with `/login` in the TUI:

```bash
pnpm dev
```

You can chat with the agent directly in the dev TUI to test the Sanity, Notion, and Blob flows. The Slack surface itself only runs against a deployment. Ship changes with:

```bash
eve deploy
```

### Evals

Asset tools check decoded paths without leading slashes before accessing storage. Reserved memory paths and malformed or ambiguous encodings are refused, including nested escapes and traversal segments.

```bash
pnpm test:smoke     # asset-path security regressions, no network or credentials
pnpm eval:offline   # mock models, no model calls, a few seconds
pnpm eval           # real models through the AI Gateway
```

The offline suite (`evals/offline/`) checks the agent's tools, approvals, memory, and subagent plumbing without calling a model. The live suite (`evals/live/`) covers research, the draft review, and a draft-quality case graded by a decision model. Live runs cost money and need AI Gateway credentials for a team that allows the `google` provider.

### Linting and formatting

This project uses [Ultracite](https://www.ultracite.ai/) (a [Biome](https://biomejs.dev/) preset) for linting and formatting:

```bash
pnpm check      # check formatting and lint rules
pnpm fix        # auto-fix what is fixable
pnpm validate   # shared-reference check, lint, typecheck, eve info, and the offline evals
```

### Setting up the connectors by hand

The Deploy button provisions these for you. To set them up manually (for a project you didn't create with the button), use the [Vercel CLI](https://vercel.com/docs/cli):

```bash
# Sanity connector, using Sanity's MCP server (set SANITY_CONNECTOR to the printed UID)
vercel connect create sanity --connection-method mcp --name copilot-agent

# Notion connector, using Notion's MCP server (set NOTION_CONNECTOR to the printed UID)
vercel connect create notion --connection-method mcp --name sanity-copilot

# Slack connector (set SLACK_CONNECTOR to the printed UID), then point its
# event trigger at the route the agent serves
vercel connect create slack --name <name> --triggers
vercel connect attach slack/<name> --triggers --trigger-path /eve/v1/slack

# Blob store, connected to the project for all environments
vercel blob create-store <name> --access private --yes
```

## Customizing

- **Behavior:** edit `agent/instructions.md`.
- **Approval gates:** edit the `APPROVAL_REQUIRED_TOOLS` lists in `agent/connections/sanity.ts` and `agent/connections/notion.ts` to change which MCP tools pause for a human decision.
- **Skills:** edit or add skills in `agent/skills/`. The reviewer keeps its own copy of `writing-quality` under `agent/subagents/reviewer/skills/`, so apply a change to `SKILL.md`, `web-content-specs.md`, or `web-writing-best-practices.md` in both copies.
- **Shared writing rules:** edit the two files in `shared-references/` (the source of truth), then run `pnpm sync:shared`. It copies them into both `writing-quality` skills, and also runs automatically on `pnpm dev` and `pnpm build`. Never edit the synced copies directly.
- **Models:** edit the ids in `agent/lib/models.ts`. The researcher picks between two models per call: a decision model reads the research request and routes deep work to one and routine lookups to the other (`agent/subagents/researcher/agent.ts`).
- **Memory:** edit `agent/memory/preferences.ts` to change what counts as a preference or who gets memory.
- **Tools:** add or change tools in `agent/tools/`. The filename is the tool name.

The agent auto-updates as you edit these files.

## Pairing with the content agent template

The [eve content agent template](https://github.com/vercel-labs/eve-content-agent-template) is a full content assistant: per-surface style skills (blog, LinkedIn, X, release notes, newsletters), a house voice, and a style lint. Instead of merging all of that into this copilot, you can deploy it as its own agent and let the copilot delegate to it through eve's [remote agents](https://eve.dev/docs/guides/remote-agents) feature.

1. Deploy the content agent template as its own Vercel project.
2. Add a remote subagent file to this repo. The filename is the tool name, and `vercelOidc()` handles deployment-to-deployment auth with no shared secret:

```ts
// agent/subagents/content_writer.ts
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: () => process.env.CONTENT_AGENT_URL ?? "https://your-content-agent.vercel.app",
  description:
    "Drafts blog posts, LinkedIn and X posts, release notes, and newsletters in the house voice. " +
    "Pass the surface, the source material, and any constraints in the message.",
  auth: vercelOidc(),
});
```

3. Set `CONTENT_AGENT_URL` in this project's environment and mention the new subagent in `agent/instructions.md` so the copilot knows when to hand off.

The remote agent runs in its own deployment with its own skills and connections, and it never sees this copilot's conversation history, so the copilot packs everything the writer needs into the call `message`. The writer's reply comes back as the task result. (The local `researcher` and `reviewer` are wrapped by the `research` and `review_draft` tools so their replies come back as structured data; a remote agent's reply is its text.)

## Learn more

- [eve on Vercel documentation](https://vercel.com/docs/frameworks/agents/eve)
- [Vercel Connect documentation](https://vercel.com/docs/connect)
- [Vercel Blob documentation](https://vercel.com/docs/vercel-blob)
- [Sanity documentation](https://www.sanity.io/docs)
- [Sanity Agent Toolkit](https://github.com/sanity-io/agent-toolkit)

## Related templates

- [eve Content Agent](https://vercel.com/templates/eve/eve-content-agent)
- [eve Agent with Python](https://vercel.com/templates/eve/eve-agent-with-python)
- [eve Data Analyst](https://vercel.com/templates/eve/eve-data-analyst)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
