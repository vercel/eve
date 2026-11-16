# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

A Slack-based Sanity copilot built on the [eve](https://eve.dev) agent framework. Users @mention it in Slack; it manages their Sanity project through the Sanity MCP connection (GROQ queries, schemas, drafts, releases), pulls source material from and drafts into Notion (user-scoped OAuth via Vercel Connect), stores files in a private Vercel Blob store, and remembers each user's standing preferences in eve memory. Its workflow lives in `agent/instructions.md`.

The whole agent is defined under `agent/`. eve discovers capabilities from the filesystem. Offline and live evals live under `evals/`. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the component map, data flow, and boundaries.

## Setup & commands

```bash
pnpm install        # install dependencies (Node 24.x)
pnpm dev            # eve dev: local TUI; run /login once to connect a model provider
pnpm typecheck      # tsc (TypeScript, no emit)
pnpm check          # ultracite (Biome) lint + format check
pnpm fix            # ultracite (Biome) auto-fix
pnpm build          # eve build
eve deploy          # deploy to Vercel production (use this, not raw `vercel deploy`)
npx eve info        # print the discovered surface + discovery diagnostics
pnpm eval:offline   # six offline evals on mock models (EVE_MOCK_MODEL=1 eve eval offline)
pnpm eval           # three live evals on real models (eve eval live); costs money, not part of validate
pnpm sync:shared    # copy shared-references/ into both writing-quality skills (also runs before dev and build)
pnpm validate       # shared-reference check + check + typecheck + eve info + eval:offline in one command
```

There is no unit-test suite. The checks are six offline evals under `evals/offline/` that run the real tools, approvals, memory, and subagent delegation on mock models, so they need no model provider. `EVE_MOCK_MODEL=1` swaps every agent's model for a mock from `agent/lib/mock-model.ts`; never set it on a deployment. Verify changes with `pnpm validate` (the shared-reference copies must be up to date, lint, typecheck, and discovery diagnostics must all report 0 errors / 0 warnings, and every offline eval must pass), then exercise the agent in the `pnpm dev` TUI.

Three live evals under `evals/live/` (`research/quick`, `review/revise`, `quality/short-draft`) run with `pnpm eval`. They call real models through the AI Gateway, so every run costs money and they are not part of `pnpm validate`. They need Gateway credentials for a team that allows the `google` provider (the decision model is `google/gemini-decision-1`) and has a credit balance.

## eve conventions

- **Read the relevant guide in `node_modules/eve/docs/` before writing code.** Don't invent framework APIs; confirm them against the docs.
- **Identity comes from the filesystem, never a `name` field.** A tool at `agent/tools/upload_asset.ts` is the tool `upload_asset`; a connection at `agent/connections/sanity.ts` registers as `sanity`.
- Authored slots: `agent/agent.ts` (model), `agent/instructions.md` (system prompt), `agent/tools/*.ts` (`defineTool`, or `defineWorkflowTool` for durable/delegating tools), `agent/connections/*.ts`, `agent/channels/*.ts`, `agent/skills/<name>/SKILL.md`, `agent/subagents/<id>/agent.ts` (`defineAgent`), `agent/memory/*.ts` (`defineMemory`), `agent/sandbox.ts`. Evals are authored outside `agent/`: `evals/evals.config.ts` (`defineEvalConfig`) and `evals/**/*.eval.ts` (`defineEval`). Shared helpers that are not slots live in `agent/lib/`. This repo also has `agent/subagents/<id>/skills/`, `agent/subagents/<id>/tools/`, and `agent/subagents/reviewer/sandbox.ts`: subagent sandboxes don't inherit from the root, and the reviewer needs one to read its skill's reference files.
- **Tools** run in the app runtime (full `process.env`), one default export per file. Gate destructive tools with `approval` from `eve/tools/approval`. A file that exports `disableTool()` from `eve/tools` removes the built-in tool of the same name: `agent/tools/bash.ts`, `write_file.ts`, and `edit_file.ts` do that for the root. Connections accept the same `approval` field: both `sanity.ts` and `notion.ts` pass a policy that substring-matches the qualified tool name against an `APPROVAL_REQUIRED_TOOLS` list. Sanity gates `patch_documents`, `publish_documents`, `unpublish_documents`, `discard_drafts`, `version_discard`, `update_dataset`, `deploy_schema`, and `deploy_studio`; Notion gates `notion-update-pages`, `notion-move-pages`, `notion-update-data-source`, and `notion-update-view` (creation is ungated).
- **Sanity Context** is an optional connection at `agent/connections/sanity-context.ts` (connection filenames allow lowercase letters, digits, and dashes only, so no underscore). It is a `defineDynamic` from `eve/connections` that returns `null` unless both `SANITY_CONTEXT_MCP_URL` and `SANITY_ORGANIZATION_TOKEN` are set, so a default deployment has no such connection. It is read-only and ungated, and it authenticates with an organization API token shared by every user. `instanceKey` is required on a dynamic connection with auth. Don't mention it in `agent/instructions.md`: the model learns about it from the connection's `description`, which exists only when the connection does.
- **Skills** are load-on-demand. A packaged skill (`<name>/SKILL.md`) requires `description` frontmatter; that description is the routing hint. Skills here: `sanity-best-practices`, `content-modeling-best-practices`, `portable-text-conversion`, `portable-text-serialization`, `seo-aeo-best-practices`, `content-experimentation-best-practices`, and `writing-quality`.
- **Memory** is declared under `agent/memory/<name>.ts` (`defineMemory`). `agent/memory/preferences.ts` uses `fileMemory()` scoped with `byPrincipal`, and only for a `principalType: "user"` session. eve recalls the user's document into the conversation each turn and generates the `preferences__save_memory` and `preferences__remove_memory` tools, so there are no hand-written preference tools. Storage is in-process under `eve dev`. On Vercel it is the project's private Blob store, the same one the asset tools use, under the `eve/memory/` prefix. It needs no setup command: per `node_modules/eve/docs/memory/file.md`, `fileMemory()` falls back to the project's attached store (`BLOB_STORE_ID`, with OIDC) when `EVE_MEMORY_BLOB_STORE_ID` is unset.
- **Subagents** are declared under `agent/subagents/<id>/agent.ts` (`defineAgent`, required `description`). The directory name is the identity (no namespace; it must not collide with a tool name, even when the subagent sets `tool: false`). Both subagents here set `tool: false`, and the root reaches them through the `defineWorkflowTool` wrappers `agent/tools/research.ts` and `agent/tools/review_draft.ts`. Each wrapper's `execute` body is marked `"use workflow"` and calls `askSubagent` (`agent/lib/subagent.ts`), which runs `ctx.agent(<id>).send(message, { outputSchema })` once and returns the validated structured result. Every call is a one-shot fresh child session that ends when the call finishes; nothing carries over between calls. Keep each subagent's `description` in step with its wrapper tool's. A declared subagent inherits nothing from the root (no skills, connections, tools, or sandbox), so the caller passes everything it needs in the `message`. Here: `researcher` and `reviewer`. The researcher sets `defaultTools: false` and re-adds only `web_search` (`webSearch({ provider: "parallel" })`) and `web_fetch` under its own `tools/`, so it has no sandbox tools. Its model is routed per call with `auto()` from `eve/models`: a decision model reads the research message and picks the deep or the standard research model, and the `research` tool's optional `depth` input (`quick`, `standard`, `deep`) is prefixed to the message as a routing hint. `research` rejects a `message` over 15,000 characters. The reviewer sets `defaultTools: false` and re-adds only `read_file` (`agent/subagents/reviewer/tools/read_file.ts`), which it needs to read its skill's reference files, so it has no shell, file-write, or web tools. It carries its own copy of the `writing-quality` skill under `agent/subagents/reviewer/skills/` plus its own `sandbox.ts`. The two reference files both copies share word for word (`ai-phrases-to-avoid.md`, `plain-english-alternatives.md`) have a single source in `shared-references/`; `scripts/sync-shared.mjs` copies them into both skills' `references/` folders on `predev` and `prebuild` and as `pnpm sync:shared`. Edit the shared files, never the copies. The other three files (`SKILL.md`, `web-content-specs.md`, `web-writing-best-practices.md`) are hand-maintained in each copy and intentionally diverge where the root's references other root-only skills (`seo-aeo-best-practices`); when editing either copy of those, keep them in step except for that.
- **Models** are all named in `agent/lib/models.ts` (`ROOT_MODEL`, `REVIEW_MODEL`, `DEEP_RESEARCH_MODEL`, `STANDARD_RESEARCH_MODEL`, `DECISION_MODEL`). Change a model there, not in an `agent.ts`.
- After editing, **check LSP diagnostics / `pnpm typecheck`** and fix type errors before moving on.

## Code style

- Linting and formatting are handled by **Ultracite** (a Biome preset). Run `pnpm check` before finishing and `pnpm fix` to auto-fix. Config is in `biome.jsonc`; the kebab-case filename rule is disabled there because eve tools use snake_case names.
- TypeScript strict; ESM with `module: esnext` and `moduleResolution: bundler` (see `tsconfig.json`). The resolver does not require it, but relative imports in this repo are written with a `.js` extension; keep that. `package.json` also maps `#*` to `./agent/*` and `#evals/*` to `./evals/*` (for example `#lib/reserved-paths.js`). Prefer `const`, arrow functions, optional chaining / nullish coalescing.
- Validate tool input/output with `zod` schemas.
- Every dependency in `package.json` is pinned to an exact version. Keep it that way when adding or upgrading one, and bump `@biomejs/biome` and `ultracite` together.
- Document exported config with TSDoc (`@remarks`, `@param`, `@returns`, `@defaultValue`, `@see`). Avoid inline `//` comments; put rationale in the TSDoc block instead.
- Prose in markdown files is not hard-wrapped: write each paragraph or bullet as one line.
- Agent-facing text (instructions, skill bodies, tool and subagent descriptions) follows the "How you write" rules in `agent/instructions.md`: no em dashes, no machine-made words, no bold for emphasis. The skills vendored from Sanity's Agent Toolkit (every skill under `agent/skills/` except `writing-quality`) are exempt, so they stay easy to update from upstream. It carries behavior only, never framework plumbing (sign-in flows, how approvals render) or references to tools and skills the reading agent can't access.

## Security

- **Never ask the user for API keys, client secrets, or any other credentials.**
- **Never commit secrets.** `.env*` is gitignored. Connector UIDs are read from env (`SLACK_CONNECTOR`, `SANITY_CONNECTOR`, `NOTION_CONNECTOR`); Sanity and Notion auth is per-user via Vercel Connect and Blob auth is via the project's OIDC token, so there are no API keys in code. The one static credential is `SANITY_ORGANIZATION_TOKEN`, used only when the optional Sanity Context connection is enabled; it is read from env and never written in code.
- If you ever build a `RegExp` from data, escape it (literal match) and bound the input length.
- Gate irreversible or high-impact actions behind `approval`: the destructive tool `delete_asset` and connection writes (the `sanity` and `notion` connections gate the write tools listed above).
- For per-user storage, derive the scope from the resolved principal (`ctx.session.auth.current`), never from model input. See `agent/memory/preferences.ts`, which scopes memory with `byPrincipal` and returns `null` for any session that is not a signed-in user.
- The Blob store is private. `upload_asset` always writes with `access: "private"` and has no `access` input, `download_asset` reads through `get(url, { access: "private" })` from `@vercel/blob`, and no asset tool returns a download link. An asset's URL is an identifier for the other asset tools, not a link a person can open.
- The asset tools refuse two reserved Blob prefixes (`agent/lib/reserved-paths.ts`): `eve/memory/`, where file memory keeps its documents in the same store, and `user-preferences/`, where an older store may still hold per-user preference files. That stops them being used to read or overwrite another user's preferences.
- `download_asset` only accepts URLs on `*.blob.vercel-storage.com`.
- Keep built-in tools to what each agent uses. Root: `read_file` (skills read their reference files with it), `web_fetch`, `web_search`, and `agent`, with `bash`, `write_file`, and `edit_file` disabled. Researcher: `web_search` and `web_fetch` only. Reviewer: `read_file` only.

## Before committing

- `pnpm validate` passes (shared-reference check, Ultracite check, `tsc`, `eve info` with 0 errors / 0 warnings, and the offline evals).
- No secrets, `node_modules`, or build output (`.eve`, `.vercel`, `.output`) staged.
