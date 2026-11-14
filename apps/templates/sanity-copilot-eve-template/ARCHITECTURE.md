# ARCHITECTURE.md

A map of how this agent is put together, for humans and AI agents working in the repo. Keep it current as the codebase evolves.

## Project identification

- **Name:** Sanity Copilot (eve template)
- **Maintainer:** Vercel Labs
- **License:** MIT
- **Last updated:** 2026-11-12

## Overview

A Slack-based Sanity copilot built on the [eve](https://eve.dev) agent framework. Users @mention it to manage a Sanity project: querying content with GROQ, shaping schemas, creating and editing drafts, and managing releases, all through Sanity's MCP server as the signed-in user. Long-form pieces are drafted into Notion pages; generated files and assets live in a private Vercel Blob store; each user's standing preferences live in eve memory, in the same store. The agent runs on Vercel, the same way locally (`eve dev`) and in production (`eve deploy`).

eve discovers every capability from the filesystem under `agent/`. There is no central registry or wiring file: a tool's name is its filename, a connection's name is its filename, and so on. Offline and live evals live beside it under `evals/`, the two reference files both `writing-quality` skill copies share live in `shared-references/`, and `scripts/sync-shared.mjs` copies them into each skill.

## Project structure

```text
agent/
  agent.ts                  # root agent (defineAgent): model, compaction threshold, session usage limit
  instructions.md           # base system prompt / behavior
  channels/
    slack.ts                # Slack surface; credentials via Vercel Connect
    eve.ts                  # inbound route auth; dev-only localDevUser shim (user principal)
  connections/
    sanity.ts               # Sanity MCP server, user-scoped OAuth; destructive tools approval-gated
    notion.ts               # Notion MCP server, user-scoped OAuth; update/move tools approval-gated
    sanity-context.ts       # optional read-only Sanity Context endpoint (dynamic; null without its env vars)
  memory/
    preferences.ts          # per-user standing preferences (defineMemory + fileMemory, scoped by principal)
  sandbox.ts                # sandbox environment (Vercel Sandbox)
  subagents/
    researcher/
      agent.ts              # tool: false, defaultTools: false; model routed per call with auto()
      instructions.md       # research method and output contract
      tools/
        web_search.ts       # webSearch({ provider: "parallel" })
        web_fetch.ts        # eve's built-in web fetch
    reviewer/
      agent.ts              # tool: false, defaultTools: false
      instructions.md       # review rubric and verdict contract
      sandbox.ts            # its own Vercel Sandbox environment
      skills/writing-quality/  # its own copy of the rubric
      tools/
        read_file.ts        # eve's built-in file read, the reviewer's only built-in tool
  tools/
    upload_asset.ts         # Vercel Blob: store text/binary (always private access)
    list_assets.ts          # Vercel Blob: browse
    get_asset_info.ts       # Vercel Blob: metadata
    download_asset.ts       # Vercel Blob: read back through the Blob SDK (Blob URLs only)
    delete_asset.ts         # Vercel Blob: delete (approval-gated)
    research.ts             # workflow tool: one researcher turn, returns cited findings + gaps
    review_draft.ts         # workflow tool: one reviewer turn, returns a verdict + issues
    bash.ts                 # disableTool(): removes the built-in bash tool from the root
    write_file.ts           # disableTool(): removes the built-in write_file tool from the root
    edit_file.ts            # disableTool(): removes the built-in edit_file tool from the root
  lib/
    models.ts               # every AI Gateway model id in one place
    mock-model.ts           # mock models used when EVE_MOCK_MODEL=1 (offline evals only)
    subagent.ts             # askSubagent: one structured turn in a fresh subagent session
    review-schema.ts        # the reviewer's verdict schema
    reserved-paths.ts       # Blob prefixes the asset tools refuse
  skills/                   # load-on-demand procedures, routed by description frontmatter
    sanity-best-practices/              # schemas, GROQ, TypeGen, functions, framework integrations
    content-modeling-best-practices/    # content types, references vs embedding, taxonomies
    portable-text-conversion/           # HTML/Markdown into Portable Text
    portable-text-serialization/        # Portable Text out to React, HTML, Markdown, etc.
    seo-aeo-best-practices/             # metadata, structured data, EEAT, AI-answer readiness
    content-experimentation-best-practices/ # A/B tests, variants, metrics, pitfalls
    writing-quality/                    # AI-tells, plain English, web-content specs
evals/
  evals.config.ts           # shared eval defaults (judge model, concurrency, timeout)
  shared.ts                 # helpers: toolScript, asRecord, hasFindings
  offline/                  # six evals on mock models (pnpm eval:offline)
    delete-approval.eval.ts       # delete_asset waits for approval; a denial rejects it
    memory.eval.ts                # a saved preference is recalled in the next session
    research-cap.eval.ts          # research rejects a message over 15,000 characters
    research-delegation.eval.ts   # research prefixes the depth and returns the structured result
    reserved-path.eval.ts         # upload_asset refuses a reserved path
    review-delegation.eval.ts     # review_draft returns the reviewer's verdict
  live/                     # three evals on real models through the AI Gateway (pnpm eval)
    research/quick.eval.ts        # one quick research call returns at least one finding
    review/revise.eval.ts         # review_draft returns revise with issues for a draft full of AI phrasing
    quality/short-draft.eval.ts   # a short draft is judged for grounding and plain English
scripts/
  sync-shared.mjs           # copies shared-references/*.md into both writing-quality skills; --check fails on a stale copy
shared-references/          # single source for the reference files both writing-quality copies share
  ai-phrases-to-avoid.md
  plain-english-alternatives.md
```

## Core components

| Component | Lives in | eve primitive | Responsibility |
| --- | --- | --- | --- |
| Slack surface | `agent/channels/slack.ts` | Channel | Receives @mentions/DMs, threads replies, renders approvals as buttons |
| Route auth | `agent/channels/eve.ts` | Channel | Inbound auth for the eve route; `vercelOidc()` is tried first, and the `localDevUser` fallback upgrades an unlinked dev principal to a user so user-scoped connections work in the dev TUI |
| Agent runtime | `agent/agent.ts` + `instructions.md` | Agent | The model loop and behavior; orchestrates skills, tools, and the connections. Its built-in tools are `read_file`, `web_fetch`, `web_search`, and `agent`; `bash`, `write_file`, and `edit_file` are disabled. Compacts history at 75% of the context window (`compaction.threshold`) and pauses a session that passes its usage limit |
| Skills | `agent/skills/<name>/` | Skill | Task-specific guidance (Sanity, content modeling, Portable Text in/out, SEO/AEO, experimentation, writing quality), loaded on demand |
| Sanity access | `agent/connections/sanity.ts` | Connection (MCP) | Query with GROQ, inspect schemas, create/edit drafts, manage releases as the signed-in user; destructive tools (`APPROVAL_REQUIRED_TOOLS`) are approval-gated |
| Notion access | `agent/connections/notion.ts` | Connection (MCP) | Search/read/write Notion as the signed-in user; update/move tools are approval-gated, page creation is not |
| Sanity Context (optional) | `agent/connections/sanity-context.ts` | Connection (MCP, dynamic) | Read-only reference knowledge from a Sanity Context endpoint. Present only when `SANITY_CONTEXT_MCP_URL` and `SANITY_ORGANIZATION_TOKEN` are set; otherwise the file returns `null` and the agent has no such connection |
| Asset tools | `agent/tools/{upload,list,get_asset_info,download,delete}_asset.ts` | Tools | Store and manage files in the project's private Vercel Blob store. Every upload is written with `access: "private"`, and `download_asset` reads through the Blob SDK's `get()`. An asset's `url` identifies it to the other asset tools; it is not a link a person can open |
| User preferences | `agent/memory/preferences.ts` | Memory | Per-user standing preferences in eve file memory, scoped to the resolved principal (never model input) and only for `principalType: "user"` sessions. eve recalls the document each turn and generates the `preferences__save_memory` and `preferences__remove_memory` tools |
| Researcher subagent | `agent/subagents/researcher/` + `agent/tools/research.ts` | Subagent + workflow tool | Fresh-context web research for facts the project's content doesn't hold; has only `web_search` (run by Parallel through the AI Gateway) and `web_fetch` (`defaultTools: false`, so no sandbox tools), returns cited findings + gaps. Its model is routed per call |
| Reviewer subagent | `agent/subagents/reviewer/` + `agent/tools/review_draft.ts` | Subagent + workflow tool | Fresh-context, verdict-only review of a finished draft; loads the rubric from its own `writing-quality` skill copy, so the root passes only the draft and context. Its only built-in tool is `read_file` (`defaultTools: false`), which it uses to read the skill's reference files |

The subagents set `tool: false`, so eve doesn't derive a model-facing tool for them. Instead the `research` and `review_draft` workflow tools (`defineWorkflowTool` with an `execute` body marked `"use workflow"`) call `askSubagent` (`agent/lib/subagent.ts`), which opens the child with `ctx.agent()`, sends one message with the turn's `outputSchema`, and returns the validated result. Each call is a one-shot: it opens a fresh child session that ends when the call finishes, so nothing carries over from one call to the next. The call blocks the root's turn until the result arrives, and a failed child turn fails the call with the child's error. `research` also takes an optional `depth` (`quick`, `standard`, or `deep`), which it prefixes to the message as a `Research depth:` line, and rejects a `message` over 15,000 characters because the researcher's model router rejects one over 16,000.

Every model id lives in `agent/lib/models.ts`. The root uses `ROOT_MODEL` and the reviewer uses `REVIEW_MODEL`. The researcher's model is chosen per call with `auto()` from `eve/models`: before the turn's first model call, `DECISION_MODEL` reads the research message and picks `DEEP_RESEARCH_MODEL` or `STANDARD_RESEARCH_MODEL`, and `STANDARD_RESEARCH_MODEL` is the fallback if the decision model itself fails. When `EVE_MOCK_MODEL=1`, all three agents run on the mock models in `agent/lib/mock-model.ts` instead. That switch exists for the offline evals and must never be set on a deployment.

Channels and the connections are I/O boundaries. Tools run in the app runtime (full `process.env`). Skills only add instructions to context; they are not an execution surface. The `researcher` and `reviewer` subagents each run in their own isolated child session (fresh context, none of the root's skills or connections), so the root passes what each needs in the call `message`. The reviewer is sent only the draft and any voice or audience context; it loads the rubric itself from its own copy of the `writing-quality` skill. That copy intentionally diverges from the root's where the root's version points at other root-only skills (e.g. `seo-aeo-best-practices`): the reviewer's copy declares those concerns out of scope instead. The divergence is confined to `SKILL.md`, `web-content-specs.md`, and `web-writing-best-practices.md`, which are maintained by hand in each copy. The other two reference files, `ai-phrases-to-avoid.md` and `plain-english-alternatives.md`, have one source in `shared-references/`, and `scripts/sync-shared.mjs` writes them into both skills' `references/` folders. It runs before `pnpm dev` and `pnpm build` and on demand as `pnpm sync:shared`. Edit the shared files, never the copies.

## Data stores

- **Sanity** (external, user-owned): the CMS the copilot manages. All access goes through Sanity's MCP server; the agent never holds a shared Sanity credential and acts as each user via their own OAuth token.
- **Notion** (external, user-owned): the destination for long-form drafts and the source for briefs and reference material. Also per-user OAuth, no shared credential.
- **Vercel Blob**: one private store for exported drafts, images, and attachments, and for eve file memory under the `eve/memory/` prefix. Authenticated by the project's OIDC token (no `BLOB_READ_WRITE_TOKEN`). The asset tools write every file with private access and read it back through the Blob SDK, so an asset's URL identifies it to the other asset tools and does not open in a browser. They refuse the `eve/memory/` prefix and the legacy `user-preferences/` prefix (`agent/lib/reserved-paths.ts`).
- **eve file memory**: one small preferences document per user. Under `eve dev` it is held in process memory and is lost when the process stops. On Vercel it is kept in the project's private Blob store, the same one the asset tools use, under the `eve/memory/` prefix. `fileMemory()` takes no store configuration here: per eve's docs (`node_modules/eve/docs/memory/file.md`) it uses `EVE_MEMORY_BLOB_STORE_ID` when that is set and otherwise the project's attached store through `BLOB_STORE_ID`, in both cases with the project's OIDC token.
- **Vercel Sandbox** (`$HOME/.agents/skills/...`): holds the seeded skill files the model reads, baked into a snapshot at build time. The reviewer subagent declares its own `sandbox.ts` because subagent sandboxes don't inherit from the root, and a subagent that shares its parent's sandbox (`defineParentSandbox()`) can't bring its own skill files. The reviewer's only tool in that sandbox is `read_file`, which it uses to read its skill's reference files; it has no shell and no file-write tools. The root likewise has `read_file` but not `bash`, `write_file`, or `edit_file`. Not a durable application data store.

There is no application database.

## External integrations

| Integration | Purpose | Method |
| --- | --- | --- |
| Slack | Chat surface (inbound events + outbound messages) | Vercel Connect connector (`SLACK_CONNECTOR`), webhook trigger at `/eve/v1/slack` |
| Sanity (MCP) | Query, edit, and release CMS content | MCP connection to `mcp.sanity.io` with user-scoped OAuth via Vercel Connect (`SANITY_CONNECTOR`) |
| Notion (MCP) | Read source material, write long-form drafts | MCP connection to `mcp.notion.com` with user-scoped OAuth via Vercel Connect (`NOTION_CONNECTOR`) |
| Sanity Context (MCP, optional) | Look up Knowledge Bases and scoped dataset content, read-only | MCP connection to the endpoint in `SANITY_CONTEXT_MCP_URL`, authenticated with the organization API token in `SANITY_ORGANIZATION_TOKEN` |
| Vercel Blob | One private store for files and assets and for file memory (under `eve/memory/`) | `@vercel/blob` for assets and eve's `fileMemory()` for memory, both OIDC-authenticated |
| Vercel AI Gateway | Model access, the researcher's model router, and its web search | Gateway model ids resolved through the linked project; all of them are named in `agent/lib/models.ts` and each `agent.ts` imports the one it uses |
| Vercel Sandbox | Isolated runtime that holds seeded skill files | `agent/sandbox.ts` and the reviewer's own `sandbox.ts` (`VercelSandbox.environment()`); `eve build` captures their snapshots, so local builds need a linked project (`vercel link` + `vercel env pull`) |

## Deployment & infrastructure

- **Platform:** Vercel. Deploy with `eve deploy` (wraps `vercel deploy --prod`); the raw `vercel deploy` cannot auto-detect the eve framework.
- **Connectors:** provisioned via the Deploy button or `vercel connect create` + `attach`; the Slack trigger must point at `/eve/v1/slack`.
- **Environment:** `SLACK_CONNECTOR`, `SANITY_CONNECTOR`, and `NOTION_CONNECTOR` (connector UIDs) in the Vercel project; the model and Blob authenticate via the project's OIDC token. `SANITY_CONTEXT_MCP_URL` and `SANITY_ORGANIZATION_TOKEN` are optional and enable the Sanity Context connection.
- **Blob store:** one private store connected to the project, provisioned by the Deploy button or `vercel blob create-store <name> --access private --yes`. It holds the asset tools' files and file memory, so memory needs no setup step of its own.
- **Local development:** `pnpm dev` runs the same runtime in a TUI; `vercel env pull` supplies a short-lived OIDC token. Preferences saved in the TUI are held in process memory, so they don't survive a restart. The Slack surface only runs against a deployment.

## Security considerations

- **Inbound route auth** (`agent/channels/eve.ts`): `[vercelOidc(), localDevUser]` rejects public browser traffic; Slack traffic is authenticated by its connector, which issues a per-user (`principalType: "user"`) principal. `vercelOidc()` is tried first. `localDevUser` (typed `EveAuthFn`) is the dev-only fallback for an unlinked `eve dev` session, which resolves to a `local-dev` principal that isn't a user, so user-scoped tool calls would fail with `principal_required`. The shim upgrades only what the framework's `localDev()` admits to a user and returns `null` for everything else, so it never affects production. It also returns `allowAgentInfo: true`, which lets the dev TUI and `eve eval` read the agent's info route as that user. It must stay after `vercelOidc()`, or the synthetic local principal shadows a real Vercel user.
- **Outbound auth:** Sanity and Notion are both per-user OAuth via Vercel Connect (tokens resolved per call, never exposed to the model); Blob uses the project OIDC token. No API keys live in code, and `.env*` is gitignored. The exception is the optional Sanity Context connection: when enabled it sends one organization API token for every user, so all users read the same scoped content regardless of their own Sanity permissions. Its endpoint is read-only.
- **Human-in-the-loop:** the irreversible tool action `delete_asset` is gated with `approval` from `eve/tools/approval`. The Sanity connection gates its destructive tools (`patch_documents`, `publish_documents`, `unpublish_documents`, `discard_drafts`, `version_discard`, `update_dataset`, `deploy_schema`, `deploy_studio`) and the Notion connection gates its update/move tools (`notion-update-pages`, `notion-move-pages`, `notion-update-data-source`, `notion-update-view`) with per-connection `approval` policies. Each renders as a Slack approve/deny button.
- **Input hardening:** `download_asset` only accepts `*.blob.vercel-storage.com` URLs (the `url` is model-supplied) and reads them through the Blob SDK with private access.
- **Private assets:** `upload_asset` always writes with `access: "private"` and has no `access` input, so the model can't make a file public. No asset tool returns a download link.
- **Least privilege on built-in tools:** each agent has only the built-in tools it uses. The root has `read_file` (skills read their reference files with it), `web_fetch`, `web_search`, and `agent`; `agent/tools/bash.ts`, `write_file.ts`, and `edit_file.ts` each export `disableTool()`, so it has no shell and no file-write tools. The researcher sets `defaultTools: false` and has only `web_search` and `web_fetch`. The reviewer sets `defaultTools: false` and has only `read_file` (`agent/subagents/reviewer/tools/read_file.ts`).
- **Per-user isolation:** the memory scope comes from the resolved principal (`ctx.session.auth.current`) through `byPrincipal`, never from model input, so a session can only read and edit its own user's preferences. Sessions that are not a signed-in user (`principalType: "user"`) get no memory at all, so app and service callers never share a document. On Vercel the documents sit in the same private Blob store as the assets, under `eve/memory/`. The general asset tools refuse that prefix and the `user-preferences/` prefix (an older store may still hold per-user preference files there), so they can't be used as a side channel to read or overwrite another user's preferences.
- **Mock models:** `EVE_MOCK_MODEL=1` replaces every model with a mock: the root's calls whatever tool a message names, and the subagents' return a fixed structured reply. It is set only by `pnpm eval:offline`; never set it on a deployment.

## Development & testing

- **Runtime/TUI:** `pnpm dev` (eve dev TUI; `/login` connects a provider, `/model` picks the model).
- **Type checking:** `pnpm typecheck` (tsc).
- **Lint/format:** `pnpm check` / `pnpm fix` (Ultracite, a Biome preset; config in `biome.jsonc`).
- **Discovery diagnostics:** `npx eve info` (must report 0 errors / 0 warnings).
- **Offline evals:** `pnpm eval:offline` (`EVE_MOCK_MODEL=1 eve eval offline`) runs the six evals under `evals/offline/` on mock models, with no model provider call. They cover the `delete_asset` approval gate, memory recall across sessions, the `research` message cap, `research` and `review_draft` delegation, and `upload_asset` refusing a path under `eve/memory/`.
- **Live evals:** `pnpm eval` (`eve eval live`) runs the three evals under `evals/live/` on real models through the AI Gateway. They cover a quick `research` call returning at least one finding, `review_draft` returning `revise` with issues for a draft full of AI phrasing, and a short draft judged by `DECISION_MODEL` for grounding and plain English. Every run costs money, so they are not part of `pnpm validate`. They need AI Gateway credentials for a team that allows the `google` provider (for `google/gemini-decision-1`) and has a credit balance.
- **Shared references:** `pnpm sync:shared` copies `shared-references/*.md` into both `writing-quality` skills; `node scripts/sync-shared.mjs --check` fails when a copy is out of date.
- **One command:** `pnpm validate` runs the shared-reference check (`node scripts/sync-shared.mjs --check`), `pnpm check`, `pnpm typecheck`, `eve info`, and `pnpm eval:offline`.
- There is no unit-test suite. The offline evals check the plumbing, not model behavior, so verify behavior in the dev TUI or with the live evals.

## Future considerations

- Gating Notion page creation: `notion-create-pages` is currently ungated because drafting into Notion is the normal flow; add it to the Notion `APPROVAL_REQUIRED_TOOLS` if creation should confirm too. Notion's MCP server exposes no delete tool, so deletions happen in the Notion UI.
- A deterministic style checker (e.g. a banned-words lint tool reading the `writing-quality` references) to complement the reviewer's model-based judgment.
- Removing the hand-kept half of the `writing-quality` duplication: `SKILL.md`, `web-content-specs.md`, and `web-writing-best-practices.md` are maintained separately in the root's and the reviewer's copies, and only the documented divergence (root-only skill references) should differ.
- Richer Sanity release workflows: multi-document releases, scheduled publishing, and release review summaries beyond the current draft-then-approve loop.

## Glossary

- **eve:** the agent framework powering this app; discovers capabilities from `agent/`.
- **Channel:** an inbound/outbound surface (here, Slack, plus the eve route's auth config).
- **Connection:** an external server (MCP/OpenAPI) exposed to the model; tools are called as `<connection>__<tool>` (e.g. `sanity__patch_documents`). Here: `sanity` and `notion`.
- **Tool:** a typed action authored with `defineTool` (or `defineWorkflowTool` when it delegates to a subagent), run in the app runtime.
- **Memory:** a per-scope store authored with `defineMemory` that eve recalls into the conversation each turn and exposes through generated save and remove tools. Here: `preferences`.
- **Eval:** a scored check under `evals/` authored with `defineEval` and run with `eve eval`.
- **Skill:** a load-on-demand Markdown procedure; the packaged form requires `description` frontmatter used for routing. Here: seven skills covering Sanity work, content modeling, Portable Text conversion and serialization, SEO/AEO, experimentation, and writing quality.
- **Subagent:** a declared agent under `agent/subagents/<id>/` that the root delegates to through a tool (here the `research` and `review_draft` workflow tools). Each call runs in its own fresh child session and inherits none of the root's skills, connections, or tools, so the root passes context in the call `message`. Here: `researcher` (web research) and `reviewer` (draft review, with its own skill copy, sandbox, and `read_file` tool).
- **Vercel Connect:** brokers OAuth/credentials for Slack, Sanity, and Notion; connectors are identified by a UID.
- **OIDC:** the project's Vercel identity token, used to authenticate Blob (and AI Gateway) without static keys.
