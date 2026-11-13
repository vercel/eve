# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Kody, a GitHub maintainer agent built on the [eve](https://eve.dev) agent framework. A weekly schedule composes a digest email of the configured repo's open issues and sends it through the **Resend** MCP connection; recipients reply to act on it (for example "create Linear issues for #1 and #2"), and replies come back in through the **resend** channel. Kody reads and triages GitHub issues through the **github** tools (GitHub Tools SDK via Vercel Connect), creates and cross-references issues through the **Linear** MCP connection, and answers when @mentioned on GitHub issues/PRs or in Linear Agent Sessions. Per-user preferences live in **Vercel Blob**. Its workflow lives in `agent/instructions.ts`.

The whole agent is defined under `agent/`. eve discovers capabilities from the filesystem. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the component map, data flow, and boundaries.

## Setup & commands

```bash
pnpm install        # install dependencies (Node 24.x)
pnpm dev            # eve dev — local TUI; run /model once to link a model provider
pnpm typecheck      # tsc (TypeScript, no emit)
pnpm check          # ultracite (Biome) lint + format check
pnpm fix            # ultracite (Biome) auto-fix
pnpm build          # eve build
eve deploy          # deploy to Vercel production (use this, not raw `vercel deploy`)
npx eve info        # print the discovered surface + discovery diagnostics
pnpm validate       # check + typecheck + eve info in one command
```

There is no unit-test suite. **Verify changes with `pnpm validate` (lint, typecheck, and discovery diagnostics must all report 0 errors / 0 warnings), then exercise the agent in the `pnpm dev` TUI.**

## eve conventions

- **Read the relevant guide in `node_modules/eve/docs/` before writing code.** Don't invent framework APIs; confirm them against the docs.
- **Identity comes from the filesystem, never a `name` field.** A tool at `agent/tools/research.ts` is the tool `research`; an extension mounted at `agent/extensions/github.ts` prefixes its tools with `github__`; a connection at `agent/connections/linear.ts` registers as `linear`.
- Authored slots: `agent/agent.ts` (model), `agent/instructions.ts` (`defineInstructions`, the system prompt; resolved at build time, injecting `RESEND_FROM_ADDRESS` into the sending-email rule), `agent/tools/*.ts` (`defineTool`, or `defineWorkflowTool` for durable workflows), `agent/extensions/*.ts` (mounted extensions), `agent/connections/*.ts`, `agent/channels/*.ts`, `agent/schedules/*.ts` (cron-triggered sessions), `agent/skills/<name>/SKILL.md`, `agent/subagents/<id>/agent.ts` (`defineAgent`), `agent/sandbox.ts`.
- **Channels:** `github` (eve GitHub channel via Vercel Connect, botName "Kody"; a custom `onComment` hook keeps the built-in mention and ignore rules but dispatches only when the commenter's `author_association` is OWNER, MEMBER, or COLLABORATOR, so untrusted accounts can't drive the agent; an `onPullRequest` hook posts a summary comment with a changed-files table on every newly opened PR, skipping bot authors but deliberately not association-gated since summarizing outside PRs is the point), `linear` (eve Linear channel via Connect; Linear Agent Sessions, where users delegate or mention the agent; a custom `onAgentSession` hook injects the requester's email as session context), `resend` (Chat SDK channel using `@resend/chat-sdk-adapter` with Redis state and streaming off; email in and out), plus the `eve` route-auth channel.
- **Tools** run in the app runtime (full `process.env`), one default export per file. Gate destructive tools with `approval` from `eve/tools/approval` (here: `clear_user_preferences`). The `github` extension (`agent/extensions/github.ts`, `@github-tools/eve-extension`) exposes the GitHub Tools `maintainer` preset as `github__<tool>` tools with credentials via Vercel Connect (the deprecated `@github-tools/sdk/connect/eve` one-liner no longer works: eve skips its tools at runtime); issue-conversation writes (`addIssueComment`, `addLabels`, `closeIssue`, `createIssue`, `removeLabel`) set `requireApproval: "never"` because the email surface cannot render an approval prompt, while higher-impact writes keep the extension's approval-by-default. The `research` tool is a `defineWorkflowTool` that opens a session with the `researcher` subagent via `ctx.agent()` and requests structured output per turn (`defineAgent` no longer takes `outputSchema`).
- **Connections** are MCP servers: `linear` (`https://mcp.linear.app/mcp`, app-scoped auth shared through `linearAuth` in `agent/lib/constants.ts` with scopes `read`, `write`, `issues:create`, `comments:create`) and `resend` (`https://mcp.resend.com/mcp`, static bearer token from `RESEND_API_KEY` via `auth.getToken` — a static token works in every session including the cron run, which has no signed-in user, and the Resend connector cannot issue app-scoped tokens; list/send emails, templates, contacts). Connections accept the same `approval` field as tools if a write needs gating; neither passes one today.
- **Schedules:** `agent/schedules/weekly-digest.ts` runs cron `0 9 * * 1` (Mondays 09:00 UTC) in markdown task mode: the prompt tells the agent to fetch open issues on `DIGEST_REPO` with the GitHub tools and send the digest to `DIGEST_EMAIL` itself with the Resend MCP tools, which gives it control of the subject line (the chat-sdk Resend adapter cannot set a subject on outbound-initiated threads). `DIGEST_REPO`, `DIGEST_EMAIL`, and `RESEND_FROM_ADDRESS` are required at module load via `requireEnv`, so a missing value fails discovery instead of producing a schedule that cannot send. The digest's structure lives in the `digest-format` skill; the schedule prompt carries only the run-specific facts (repo, recipient, sender, subject). Replies to the digest reach the agent through the resend channel's inbound webhook.
- **Skills** are load-on-demand. A packaged skill (`<name>/SKILL.md`) requires `description` frontmatter; that description is the routing hint. The skills here are `writing-quality`, `digest-format`, `triaging-issues`, and `github-linear-bridging`.
- **Subagents** are declared under `agent/subagents/<id>/agent.ts` (`defineAgent`, required `description` — the routing hint). The directory name is the identity and the lowered tool name (no namespace; it must not collide with a tool name, and eve's build still rejects the collision even when the subagent sets `tool: false`, so a wrapping tool needs its own name, like `research`). A declared subagent runs in a fresh child session and **inherits nothing** from the root (no skills, connections, tools, or sandbox), so the caller passes everything it needs in the `message`. The one subagent here is `researcher`; it sets `tool: false` and is reached only through the `research` workflow tool.
- After editing, **check LSP diagnostics / `pnpm typecheck`** and fix type errors before moving on.

## Code style

- Linting and formatting are handled by **Ultracite** (a Biome preset). Run `pnpm check` before finishing and `pnpm fix` to auto-fix. Config is in `biome.jsonc`; the kebab-case filename rule is disabled there because eve tools use snake_case names.
- TypeScript strict; ESM with `NodeNext` resolution (relative imports need a `.js` extension). Prefer `const`, arrow functions, optional chaining / nullish coalescing.
- Validate tool input/output with `zod` schemas.
- Document exported config with **TSDoc** (`@remarks`, `@param`, `@returns`, `@defaultValue`, `@see`). Avoid inline `//` comments — put rationale in the TSDoc block instead.
- Prose in markdown files is not hard-wrapped: write each paragraph or bullet as one line.
- Agent-facing text (instructions, skill bodies, tool and subagent descriptions) follows the "How you write" rules in `agent/instructions.ts`: no em dashes, no machine-made words, no bold for emphasis. It carries behavior only, never framework plumbing (sign-in flows, how approvals render) or references to tools and skills the reading agent can't access.

## Security

- **Never ask the user for API keys, client secrets, or any other credentials.**
- **Never commit secrets.** `.env*` is gitignored. Connector UIDs are read from env (`GITHUB_CONNECTOR`, `LINEAR_CONNECTOR`); GitHub and Linear auth is brokered by Vercel Connect (Linear is app-scoped through `linearAuth`; tokens are resolved per call and never exposed to the model) and Blob auth is via the project's OIDC token. The Resend MCP connection and the Resend chat-sdk adapter authenticate with `RESEND_API_KEY` (plus `RESEND_WEBHOOK_SECRET` for inbound), read from env and never committed. Other config comes from env too: `DIGEST_REPO`, `DIGEST_EMAIL`, `RESEND_FROM_ADDRESS` and optional `RESEND_FROM_NAME` (the sender identity, resolved at build time; the name falls back to "Kody"), `REDIS_URL` for `@chat-adapter/state-redis`. The email channel reads the same two sender variables, so channel replies and agent-sent mail share one identity.
- If you ever build a `RegExp` from data, escape it (literal match) and bound the input length.
- Gate irreversible or high-impact actions behind `approval` (here: `clear_user_preferences`).
- For per-user storage, derive the key from the resolved principal (`ctx.session.auth.current`), never from model input — see `agent/lib/user-preferences.ts`. The preference files live under the reserved `user-preferences/` Blob prefix, reachable only through the principal-scoped preference tools.

## Before committing

- `pnpm validate` passes (Ultracite check, `tsc`, and `eve info` with 0 errors / 0 warnings).
- No secrets, `node_modules`, or build output (`.eve`, `.vercel`, `.output`) staged.
