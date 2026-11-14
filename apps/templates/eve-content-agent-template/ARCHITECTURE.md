# ARCHITECTURE.md

A map of how this agent is put together, for humans and AI agents working in the repo. Keep
it current as the codebase evolves.

## Project identification

- **Name:** Content Agent (eve content assistant template)
- **Maintainer:** Vercel Labs
- **License:** MIT
- **Last updated:** 2026-10-24

## Overview

A Slack-based content assistant built on the [eve](https://eve.dev) agent framework.
Writers talk to it in Slack; it loads a per-surface style skill, reads source material from
Notion, drafts in the house voice, and writes approved pieces back to Notion as the
signed-in writer. Generated files and assets live in Vercel Blob. The agent runs on Vercel,
the same way locally (`eve dev`) and in production (`eve deploy`).

eve discovers every capability from the filesystem under `agent/`. There is no central
registry or wiring file: a tool's name is its filename, a connection's name is its filename,
and so on.

## Project structure

```text
agent/
  agent.ts                  # model configuration (defineAgent)
  instructions.md           # base system prompt / behavior
  channels/
    slack.ts                # Slack surface; credentials via Vercel Connect
    eve.ts                  # default HTTP channel; local dev sessions get a user principal
  connections/
    notion.ts               # Notion MCP server, user-scoped OAuth; page creation approval-gated
  sandbox.ts                # sandbox environment (Vercel Sandbox)
  memory/
    preferences.ts          # per-writer style preferences (eve file memory, user-scoped)
  subagents/
    researcher/             # agent.ts + instructions.md; fresh-context web researcher (web tools only)
    reviewer/               # agent.ts + instructions.md + tools/get_surface_rubric.ts + lib/rubric.generated.ts
  tools/
    research.ts             # workflow tool: runs the researcher subagent, returns cited findings + gaps
    review.ts               # workflow tool: runs the reviewer subagent, returns a verdict + issues
    check_style.ts          # workflow tool: banned-words pass, decide() rules, reviewer fallback
    upload_asset.ts         # Vercel Blob: store text/binary
    list_assets.ts          # Vercel Blob: browse
    get_asset_info.ts       # Vercel Blob: metadata
    download_asset.ts       # Vercel Blob: read back (Blob URLs only)
    delete_asset.ts         # Vercel Blob: delete (approval-gated)
    detect_surface.ts       # decide() choice: which surface a request is for, or "ask"
    bash.ts, write_file.ts, edit_file.ts  # disableTool(): built-ins the root doesn't need
  lib/
    reserved-paths.ts       # Blob prefixes the asset tools refuse (writer memory)
    mock-model.ts           # mock models for the offline evals (EVE_MOCK_MODEL=1)
    surfaces.generated.ts   # generated shared SURFACES enum (skill folders are the source of truth)
    banned-words.generated.ts # generated per-surface banned-words lists (from each skill's banned-words.json)
  skills/                   # one style skill per surface; shared refs synced into each
    blog-style/             # SKILL.md + references/{best-practices.md, format-specs.md, banned-words.json}
    linkedin-style/         # SKILL.md + references/{best-practices.md, post-specs.md, banned-words.json}
    x-style/                # SKILL.md + references/{best-practices.md, post-specs.md, banned-words.json}
    release-notes-style/    # SKILL.md + references/banned-words.json
    newsletter-style/       # "
shared-references/          # house-wide writing rules (source of truth), synced into each skill
  ai-phrases-to-avoid.md
  plain-english-alternatives.md
scripts/
  sync-shared.mjs           # syncs shared refs into skills; generates SURFACES, banned words + reviewer rubric (pnpm sync:shared)
```

## Core components

| Component           | Lives in                                                            | eve primitive            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slack surface       | `agent/channels/slack.ts`                                           | Channel                  | Receives @mentions/DMs, threads replies, renders approvals as buttons                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Agent runtime       | `agent/agent.ts` + `instructions.md`                                | Agent                    | The model loop and behavior; orchestrates skills, tools, and the connection                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Style skills        | `agent/skills/<surface>-style/`                                     | Skill                    | Voice/structure rules per surface (blog, LinkedIn, X, release-notes, newsletter), loaded on demand; house-wide rules synced in from `shared-references/`                                                                                                                                                                                                                                                                                                                                                           |
| Style check         | `agent/tools/check_style.ts`                                        | Workflow tool            | Three stages: a deterministic banned-words pass against the lists bundled from each skill's `banned-words.json` (`agent/lib/banned-words.generated.ts`); `decide()` yes/no questions on the judgment rules, answered by the decision model with a probability each; and a fallback to the reviewer subagent when the decision model fails or a probability is between 0.25 and 0.75. `escalation` in the result says which path ran                                                                                |
| Notion access       | `agent/connections/notion.ts`                                       | Connection (MCP)         | Search/read/write Notion as the signed-in writer; page creation (`notion-create-pages`) is approval-gated                                                                                                                                                                                                                                                                                                                                                                                                          |
| Asset tools         | `agent/tools/{upload,list,get_asset_info,download,delete}_asset.ts` | Tools                    | Store and manage files in Vercel Blob                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Writer preferences  | `agent/memory/preferences.ts`                                       | Memory (file)            | Per-writer standing style preferences: one document per signed-in writer, recalled into every turn and edited by the model with `preferences__save_memory` / `preferences__remove_memory`; scoped to the resolved principal (never model input)                                                                                                                                                                                                                                                                    |
| Surface detection   | `agent/tools/detect_surface.ts`                                     | Tool                     | One `decide()` choice over the surfaces (described by each skill's `description`) plus a "not stated" option; returns a surface only at a probability of 0.75 or more, otherwise the agent asks                                                                                                                                                                                                                                                                                                                    |
| Researcher subagent | `agent/subagents/researcher/` + `agent/tools/research.ts`           | Subagent + workflow tool | Fresh-context web research for facts Notion doesn't cover; its only tools are `web_search` (Parallel, through the AI Gateway) and `web_fetch`. The root calls the `research` tool, which opens the subagent with `ctx.agent()` and requests cited findings + gaps as the turn's `outputSchema`. The subagent's model is routed per call by `auto()` from `eve/models`: the decision model reads the research message (prefixed with the tool's optional `depth`) and picks the deep or the standard research model |
| Reviewer subagent   | `agent/subagents/reviewer/` + `agent/tools/review.ts`               | Subagent + workflow tool | Fresh-context, verdict-only review of a finished draft; pulls the surface rubric itself via its `get_surface_rubric` tool (a generated bundle). The root calls the `review` tool with only the surface and draft and gets back a structured verdict                                                                                                                                                                                                                                                                |

Channels and the connection are I/O boundaries. Tools run in the app runtime (full
`process.env`). Skills only add instructions to context; they are not an execution surface. The
`researcher` and `reviewer` subagents each run in their own isolated child session — fresh
context, none of the root's skills or connections — so the root passes what each needs in the call
`message`. The reviewer is sent only the surface and draft; it loads the rubric itself through its
own `get_surface_rubric` tool. Both subagents set `tool: false`: eve no longer accepts
`outputSchema` on `defineAgent`, so the `research` and `review` workflow tools are the model-facing
entry points that request structured output per turn. (They can't reuse the subagents' names —
eve rejects a tool and a subagent with the same public name.)

## Data stores

- **Notion** (external, user-owned): the source material and the destination **Drafts**
  database. The agent never holds a shared Notion credential; it acts as each writer via
  their own OAuth token.
- **Vercel Blob**: object storage for exported drafts, images, and attachments. Authenticated
  by the project's OIDC token (no `BLOB_READ_WRITE_TOKEN`).
- **Writer memory** (`agent/memory/preferences.ts`): eve's file memory keeps one small document
  of standing style preferences per signed-in writer. eve recalls it into each turn and the
  model edits it with `preferences__save_memory` / `preferences__remove_memory`. On Vercel it
  lives as private objects under `eve/memory/` in the project's private Blob store, the same
  store the asset tools use; in `eve dev` it lives in process memory.
- **Vercel Sandbox** (`$HOME/.agents/skills/...`): holds the seeded skill files the model reads.
  Not a durable application data store.

There is no application database.

## External integrations

| Integration       | Purpose                                           | Method                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack             | Chat surface (inbound events + outbound messages) | Vercel Connect connector (`SLACK_CONNECTOR`), webhook trigger at `/eve/v1/slack`                                                                                                                                                                                                                                                                  |
| Notion (MCP)      | Read source material, write drafts                | MCP connection with user-scoped OAuth via Vercel Connect (`NOTION_CONNECTOR`)                                                                                                                                                                                                                                                                     |
| Vercel Blob       | File/asset storage                                | `@vercel/blob`, OIDC-authenticated                                                                                                                                                                                                                                                                                                                |
| Vercel AI Gateway | Model access                                      | Gateway model ids in `agent/lib/models.ts`, resolved through the linked project: `anthropic/claude-opus-5.5` (root), `openai/gpt-6.1-sol` (reviewer), `anthropic/claude-fable-5.2` or `anthropic/claude-opus-5.5-fast` for research (routed per call by `auto()`), and `google/gemini-decision-1` (the router and `check_style`'s decision model) |
| Vercel Sandbox    | Isolated runtime that holds seeded skill files    | `agent/sandbox.ts` (`VercelSandbox.environment()`)                                                                                                                                                                                                                                                                                                |

## Deployment & infrastructure

- **Platform:** Vercel. Deploy with `eve deploy` (wraps `vercel deploy --prod`); the raw
  `vercel deploy` cannot auto-detect the eve framework.
- **Connectors:** provisioned via the Deploy button or `vercel connect create` + `attach`;
  the Slack trigger must point at `/eve/v1/slack`.
- **Environment:** `SLACK_CONNECTOR` and `NOTION_CONNECTOR` (connector UIDs) in the Vercel
  project; the model and Blob authenticate via the project's OIDC token.
- **Build:** `eve build` prepares the root's Vercel Sandbox snapshot (it seeds the skill files),
  so it needs Vercel credentials: automatic on Vercel, or a linked project (`vercel link` +
  `vercel env pull`) locally. The subagents have no sandbox tools, so they never open one.
- **Local development:** `pnpm dev` runs the same runtime in a TUI; `vercel env pull`
  supplies a short-lived OIDC token. The Slack surface only runs against a deployment.

## Security considerations

- **Inbound route auth** (`agent/channels/`): `agent/channels/eve.ts` keeps the framework's
  `localDev()` + `vercelOidc()` pair, which rejects public browser traffic, and marks local dev
  sessions as a user principal so the user-scoped Notion connection works in the TUI; Slack
  traffic is authenticated by its connector. Slack's `defaultSlackAuth` issues a per-user
  (`principalType: "user"`) principal.
- **Outbound auth:** Notion is per-writer OAuth via Vercel Connect (token resolved per call,
  never exposed to the model); Blob uses the project OIDC token. No API keys live in code,
  and `.env*` is gitignored.
- **Human-in-the-loop:** irreversible tool actions (`delete_asset`)
  are gated with `approval` from `eve/tools/approval`, and the Notion connection gates page
  creation (`notion-create-pages`) with a per-connection `approval` policy. Each renders as a
  Slack approve/deny button.
- **Input hardening:** `check_style` (via `agent/lib/banned-words.ts`) escapes banned words before building a `RegExp`
  (prevents ReDoS) and bounds input length; `download_asset` only fetches
  `*.blob.vercel-storage.com` URLs (prevents SSRF).
- **Per-writer isolation:** the memory slot's scope comes from the resolved principal
  (`ctx.session.auth.current`), never from model input, and only `user` principals get a
  document, so a session can only read or change its own writer's preferences. The asset tools
  refuse the Blob prefixes in `agent/lib/reserved-paths.ts`, so they can't be used as a side
  channel.
- **Least-privilege tools:** the root has `bash`, `write_file`, and `edit_file` disabled and
  keeps `read_file` for skill references; the researcher and reviewer set `defaultTools: false`; the researcher adds back
  only `web_search` and `web_fetch`, so fetched web content can't reach a shell or the
  filesystem, and the reviewer has only `get_surface_rubric`.
- **Mock models:** `EVE_MOCK_MODEL=1` swaps every agent's model for a mock
  (`agent/lib/mock-model.ts`) for the offline evals. Never set it on a deployment that serves
  writers.

## Development & testing

- **Runtime/TUI:** `pnpm dev` (eve dev TUI; `/model` links a provider).
- **Type checking:** `pnpm typecheck` (tsc).
- **Lint/format:** `pnpm check` / `pnpm fix` (Ultracite, a Biome preset; config in
  `biome.jsonc`).
- **Discovery diagnostics:** `npx eve info` (must report 0 errors / 0 warnings).
- **Offline evals:** `pnpm eval:offline` runs `evals/offline/` against a local server on mock
  models: no model calls, a few seconds. It covers the banned-words matcher, the `research`
  input cap and depth prefix, the subagent plumbing behind `research` and `review`, approval on
  `delete_asset`, the reserved Blob prefixes, and memory carrying across sessions.
- **Live evals:** `pnpm eval` runs `evals/live/` on real models: the style check and its
  decision model, surface detection, research, and a draft-quality case graded by `t.judge`.
  `check-style/decision-rules` fails when the decision model is unreachable, so a broken decider
  can't hide behind `check_style`'s reviewer fallback.
- There is no unit-test suite; verify behavior with the evals and in the dev TUI.

## Future considerations

- Richer Markdown to Notion block conversion (headings, lists, code) beyond paragraph splits.
- Optional asset tools not yet included: `copy_asset` and bulk `delete_assets`.
- Extending the Notion write gate: `notion-create-pages` is already approval-gated at the
  connection level; add `notion-update-page` / `notion-update-database` to
  `APPROVAL_REQUIRED_TOOLS` if edits should confirm too. Notion's MCP server exposes no delete
  tool, so deletions happen in the Notion UI.

## Glossary

- **eve:** the agent framework powering this app; discovers capabilities from `agent/`.
- **Channel:** an inbound/outbound surface (here, Slack).
- **Connection:** an external server (MCP/OpenAPI) exposed to the model; its tools are named
  `<connection>__<tool>` (e.g. `notion__notion-search`), found with `eve__search`, and called with
  `eve__tool`.
- **Tool:** a typed action authored with `defineTool`, run in the app runtime.
- **Skill:** a load-on-demand Markdown procedure; the packaged form requires `description`
  frontmatter used for routing.
- **Subagent:** a declared agent under `agent/subagents/<id>/` that the root delegates to
  (here through the `research` and `review` workflow tools). It runs in its own fresh child session and inherits none of the root's skills,
  connections, or tools, so the root passes context in the call `message`. Here: `researcher`
  (web research) and `reviewer` (draft review).
- **Surface:** a content type with its own style skill (blog, LinkedIn, X, release-notes,
  newsletter).
- **Shared references:** house-wide writing rules in `shared-references/` (the source of
  truth). `scripts/sync-shared.mjs` (`pnpm sync:shared`, also run on `predev`/`prebuild`) copies
  them into every skill's `references/` and regenerates the managed `## Shared references` section
  in each `SKILL.md`; the skill's own `## References` section is preserved. The same script also
  generates `agent/lib/surfaces.generated.ts` (the shared `SURFACES` enum),
  `agent/lib/banned-words.generated.ts`, and the reviewer's rubric module. Edit the source, never the synced copies or generated files.
- **Vercel Connect:** brokers OAuth/credentials for Slack and Notion; connectors are
  identified by a UID.
- **OIDC:** the project's Vercel identity token, used to authenticate Blob (and AI Gateway)
  without static keys.
