# ARCHITECTURE.md

A map of how this agent is put together, for humans and AI agents working in the repo. Keep it current as the codebase evolves.

## Project identification

- **Name:** Kody, GitHub maintainer agent (eve template)
- **Maintainer:** Vercel Labs
- **License:** MIT
- **Last updated:** 2026-07-23

## Overview

A personal GitHub maintainer agent built on the [eve](https://eve.dev) agent framework, made for freelancers and solo maintainers: one person, one repo, one inbox. Every Monday a scheduled session composes a digest of the configured repo's open issues and emails it to the configured recipient with the Resend MCP tools; the reader replies to act on it ("create Linear issues for #1 and #2 and assign them to me") and the agent follows through, confirming by email with links. Between digests Kody keeps working the repo: it posts an orienting summary comment when a pull request opens, answers @mentions on GitHub issues and PRs in-thread, and handles the issues users delegate or mention it on in Linear (Agent Sessions, e.g. "email me a summary of this issue"). GitHub issue access goes through the GitHub Tools SDK; Linear and Resend are MCP connections; per-user preferences live in Vercel Blob. The agent runs on Vercel, the same way locally (`eve dev`) and in production (`eve deploy`).

eve discovers every capability from the filesystem under `agent/`. There is no central registry or wiring file: a tool's name is its filename, a connection's name is its filename, and so on.

## Project structure

```text
agent/
  agent.ts                  # model configuration (defineAgent): compaction + session usage limit (limits.sessionUsage)
  instructions.ts           # defineInstructions: system prompt, resolved at build time (injects RESEND_FROM_ADDRESS)
  channels/
    github.ts               # eve GitHub channel via Vercel Connect; botName "Kody", @mentions reply in-thread (gated to owner/member/collaborator commenters), onPullRequest posts a summary comment on opened PRs (bots skipped)
    linear.ts               # eve Linear channel via Vercel Connect; Agent Sessions, onAgentSession injects requester email; dev-only webhook-trust flag
    resend.ts               # Chat SDK channel: @resend/chat-sdk-adapter + Redis state, streaming off; email in/out
    eve.ts                  # inbound route auth; dev-only localDevUser shim (user principal)
  connections/
    linear.ts               # Linear MCP server (mcp.linear.app); app-scoped auth via linearAuth
    resend.ts               # Resend MCP server (mcp.resend.com); static RESEND_API_KEY bearer; list/send emails, templates, contacts
  schedules/
    weekly-digest.ts        # cron "0 9 * * 1" (UTC), markdown task mode: fetch issues, send the digest via the Resend MCP tools; structure comes from the digest-format skill
  sandbox.ts                # sandbox environment (VercelSandbox.environment(), exported for build-time snapshot prep)
  subagents/
    researcher/             # agent.ts + instructions.md; fresh-context web researcher (web tools only; tool: false, reached via tools/research.ts)
  extensions/
    github.ts               # GitHub Tools eve extension (maintainer preset, github__* tools): read/triage issues; issue writes ungated
  tools/
    research.ts             # workflow tool: ctx.agent("researcher") with a per-turn outputSchema; returns cited findings + gaps
    get_user_preferences.ts   # Blob: load this user's saved preferences
    save_user_preferences.ts  # Blob: save standing preferences (principal-scoped)
    clear_user_preferences.ts # Blob: clear this user's preferences (approval-gated)
  lib/
    constants.ts            # requireEnv + linearAuth: shared app-scoped Linear authorization via Vercel Connect
    user-preferences.ts     # principal-scoped Blob key + reserved-prefix guard (shared helper)
  skills/                   # load-on-demand procedures, routed by description frontmatter
    writing-quality/        # AI-tells, plain English, web-content specs
    digest-format/          # weekly digest structure: grouping, needs-attention/stale criteria, one-line summaries
    triaging-issues/        # triage playbook: dedupe, repo-native labels, ask-or-close, repro requests
    github-linear-bridging/ # bridged Linear issues: dedupe check, backlinks, team choice, two-way links
```

## Core components

| Component | Lives in | eve primitive | Responsibility |
| --- | --- | --- | --- |
| GitHub surface | `agent/channels/github.ts` | Channel | Receives @Kody mentions on issues/PRs and replies in-thread; a custom `onComment` hook dispatches only for commenters whose `author_association` is OWNER, MEMBER, or COLLABORATOR; an `onPullRequest` hook dispatches on opened PRs (bot authors skipped, not association-gated) to post a summary comment with a changed-files table |
| Linear surface | `agent/channels/linear.ts` | Channel | Linear Agent Sessions: users delegate/mention the agent on an issue; the `onAgentSession` hook injects the requester's name and email as session context; elicitations render natively |
| Email surface | `agent/channels/resend.ts` | Channel | Chat SDK channel over the Resend adapter with Redis-backed thread state; receives replies (including digest replies) and answers on the same thread |
| Route auth | `agent/channels/eve.ts` | Channel | Inbound auth for the eve route; the `localDevUser` shim upgrades the dev principal to a user so user-scoped features work in the dev TUI |
| Weekly digest | `agent/schedules/weekly-digest.ts` | Schedule | Cron `0 9 * * 1` (Mondays 09:00 UTC), markdown task mode: the agent fetches open issues on `DIGEST_REPO` with the GitHub tools and sends the digest to `DIGEST_EMAIL` itself via the Resend MCP tools, with citable #issue numbers and a controlled subject line; structure comes from the `digest-format` skill, and `DIGEST_REPO`/`DIGEST_EMAIL`/`RESEND_FROM_ADDRESS` are required at module load (`requireEnv`), failing discovery when missing |
| Agent runtime | `agent/agent.ts` + `instructions.ts` | Agent | The model loop and behavior; the prompt is compiled at build time with the `RESEND_FROM_ADDRESS` sender rule baked in |
| GitHub access | `agent/extensions/github.ts` | Extension | GitHub Tools eve extension (`@github-tools/eve-extension`, maintainer preset, tools named `github__<tool>`) via Vercel Connect: read and triage issues on the repo; issue-conversation writes run without approval, higher-impact writes keep the extension's approval default |
| Linear access | `agent/connections/linear.ts` | Connection (MCP) | Create issues, comment, and cross-reference Linear; app-scoped auth shared via `linearAuth` (`agent/lib/constants.ts`) |
| Resend access | `agent/connections/resend.ts` | Connection (MCP) | List and send emails, manage templates and contacts; sends the weekly digest and any mail initiated outside an email thread (e.g. from a Linear session); static bearer token from `RESEND_API_KEY` |
| User preferences | `agent/tools/{get,save,clear}_user_preferences.ts` + `agent/lib/user-preferences.ts` | Tools | Per-user standing preferences in Blob, keyed to the resolved principal (never model input) |
| Skills | `agent/skills/` | Skill | Load-on-demand procedures: `writing-quality` (prose rules, loaded before drafting for humans), `digest-format` (the weekly digest's structure and criteria), `triaging-issues` (the triage playbook), `github-linear-bridging` (bridged-issue conventions and cross-links) |
| Researcher subagent | `agent/subagents/researcher/` + `agent/tools/research.ts` | Subagent + workflow tool | Fresh-context web research for facts the repo and tracker don't hold; uses framework `web_search`/`web_fetch`. The subagent is hidden (`tool: false`); the `research` workflow tool opens a session with it and requests the cited findings + gaps as structured output for that turn |

Channels and the connections are I/O boundaries. Tools run in the app runtime (full `process.env`). Skills only add instructions to context; they are not an execution surface. The `researcher` subagent runs in its own isolated child session, fresh context with none of the root's skills, connections, or tools, so the root packs everything it needs into the call `message`.

## Data flow

1. **Weekly digest:** the schedule fires a markdown task session. The agent fetches all open issues on `DIGEST_REPO` with the `github` tools, composes the digest following the `digest-format` skill (needs attention, recent activity, stale; every issue cited as #N), and sends it to `DIGEST_EMAIL` itself with the `resend` MCP tools. Sending through the connection rather than the channel gives it control of the subject line, which the chat-sdk Resend adapter cannot set on outbound-initiated threads.
2. **Email replies:** a reply to the digest (or any email to the agent) lands on the resend channel's inbound webhook (thread state in Redis). The agent resolves the referenced issue numbers against GitHub, performs the request (e.g. creates Linear issues via the `linear` connection), and replies on the same thread with links.
3. **Linear sessions:** a user delegates/mentions the agent on a Linear issue; the channel injects the issue context, and the `onAgentSession` hook adds the requester's name and email so "email me a summary" needs no follow-up question. The agent works the request, sending any email via the `resend` connection; if it still lacks an address it asks in-session (Linear renders elicitations natively) and saves it with the preference tools.
4. **GitHub mentions:** @Kody on an issue or PR starts a session on the github channel; the agent answers in-thread, cross-referencing Linear through the MCP connection when useful.
5. **PR opened:** the `pull_request` webhook hits the github channel's `onPullRequest` hook, which dispatches a session anchored to the PR (opened action only, bot authors skipped) with the summary task injected as context. The channel supplies the PR metadata and changed-file patches; the agent posts one comment: what the PR does, a changed-files table, and where to start reviewing.

## Data stores

- **GitHub** (external): the repository and issue tracker the agent digests and triages. All access goes through the GitHub Tools eve extension with credentials brokered by Vercel Connect; no token in code.
- **Linear** (external): where actioned issues land and where Agent Sessions run. Access via Linear's MCP server with app-scoped Connect auth (scopes `read`, `write`, `issues:create`, `comments:create`).
- **Redis**: thread/conversation state for the Chat SDK email channel (`@chat-adapter/state-redis`). Configured via env.
- **Vercel Blob**: per-user preferences under the reserved `user-preferences/<hashed-principal>.md` prefix, reachable only through the principal-scoped preference tools. Authenticated by the project's OIDC token (no `BLOB_READ_WRITE_TOKEN`).
- **Vercel Sandbox** (`/workspace/skills/...`): holds the seeded skill files the model reads. Not a durable application data store.

There is no application database.

## External integrations

| Integration | Purpose | Method |
| --- | --- | --- |
| GitHub | Issue/PR mentions and PR-opened events in, in-thread replies and PR summary comments out; issue reads and triage | eve GitHub channel + GitHub Tools eve extension (maintainer preset), both via Vercel Connect (`GITHUB_CONNECTOR`) |
| Linear (channel + MCP) | Agent Sessions in; issue creation, comments, and cross-references out | eve Linear channel via Connect (with an `onAgentSession` hook adding the requester's email to context); MCP connection to `mcp.linear.app` with app-scoped auth shared through `linearAuth` (`LINEAR_CONNECTOR`) |
| Resend (channel + MCP) | Email in (replies) and out (digest, confirmations, summaries) | Chat SDK channel with `@resend/chat-sdk-adapter` (Redis state, streaming off) plus MCP connection to `mcp.resend.com` (static bearer from `RESEND_API_KEY`); the channel's sender identity is set in `agent/channels/resend.ts`, the digest's in `RESEND_FROM_ADDRESS` |
| Vercel Blob | Per-user preference storage | `@vercel/blob`, OIDC-authenticated |
| Vercel AI Gateway | Model access | Gateway model ids resolved through the linked project; the root model is set in `agent/agent.ts` and the subagent sets its own in `agent/subagents/researcher/agent.ts` |
| Vercel Sandbox | Isolated runtime that holds seeded skill files | `agent/sandbox.ts` (`VercelSandbox.environment()`; `eve build` snapshots it, so local builds need the linked project's credentials) |

## Deployment & infrastructure

- **Platform:** Vercel. Deploy with `eve deploy` (wraps `vercel deploy --prod`); the raw `vercel deploy` cannot auto-detect the eve framework.
- **Connectors:** provisioned via `vercel connect create` + `attach`; the GitHub trigger must point at `/eve/v1/github` and the Linear trigger at `/eve/v1/linear`. Resend's inbound webhook points at `/eve/v1/resend`.
- **Environment:** connector UIDs `GITHUB_CONNECTOR` and `LINEAR_CONNECTOR`; Resend auth `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`; sender identity `RESEND_FROM_ADDRESS` and optional `RESEND_FROM_NAME` (compiled into the system prompt at build time; the name falls back to "Kody"); digest config `DIGEST_REPO` and `DIGEST_EMAIL` (required at module load; a missing value fails discovery); `REDIS_URL` for `@chat-adapter/state-redis` (any Redis; the deploy button provisions it through the Upstash for Redis marketplace integration, which injects the variable). The email channel reads the same two sender variables, so channel replies and agent-sent mail share one identity. The model and Blob authenticate via the project's OIDC token.
- **Local development:** `pnpm dev` runs the same runtime in a TUI; `vercel env pull` supplies a short-lived OIDC token. The chat surfaces (GitHub, Linear, email) run against a deployment. Schedules never fire on cadence in dev; trigger the digest once with `POST /eve/v1/dev/schedules/weekly-digest`.

## Security considerations

- **Inbound route auth** (`agent/channels/eve.ts`): `[localDevUser, vercelOidc()]` rejects public browser traffic; channel traffic is authenticated by each connector. `localDevUser` defers the trust decision to the framework's `localDev()` and only upgrades the resolved dev principal to a user, so user-scoped features work from the dev TUI without affecting production.
- **Outbound auth:** GitHub and Linear credentials are brokered by Vercel Connect; Linear is app-scoped through the shared `linearAuth` (tokens resolved per call, never exposed to the model). Resend uses a static bearer token from `RESEND_API_KEY` (the Resend connector cannot issue app-scoped tokens and the cron run has no signed-in user); the token is resolved per call and never exposed to the model. Blob uses the project OIDC token. No credentials live in code, and `.env*` is gitignored.
- **Human-in-the-loop:** the irreversible `clear_user_preferences` tool is gated with `approval` from `eve/tools/approval`. The GitHub tool set ungates the reversible issue-conversation writes (comment, label, create/close issue) because the email surface cannot render an approval prompt; merges, pushes, and other higher-impact writes keep the extension's approval default. The connections accept the same `approval` field; neither passes a policy today (see Future considerations).
- **Per-user isolation:** the preference tools derive their Blob key from the resolved principal (`ctx.session.auth.current`), never from model input, so a session can only touch its own user's file; the id is hashed so the stored path carries no raw identifier. Preference files live under the reserved `user-preferences/` prefix. The Blob store is provisioned public, so preferences are scoped, not strongly confidential — use a private store if that matters.
- **Mention authorization:** the github channel's `onComment` hook keeps the built-in mention and ignore rules but dispatches only when the commenter's `author_association` is OWNER, MEMBER, or COLLABORATOR. On a public repo, arbitrary accounts can @mention the agent, and a dispatched session carries ungated GitHub writes, app-scoped Linear read/write, and email sending; the association gate keeps those tools drivable only by people the repo already trusts with write access. Untrusted mentions are acknowledged without a session.
- **Prompt-injection surface:** the agent reads issue bodies, comments, inbound email, and PR titles, descriptions, and diffs written by third parties. The PR-opened hook means a session starts on third-party content with no human mention at all (deliberately: summarizing outside PRs is the feature); its injected task is scoped to posting a single summary comment, the instructions forbid it from reviewing or requesting anything, and the ungated GitHub writes are limited to reversible issue-conversation actions on the configured repo, which bounds what injected text can trigger without a human approval. Instruction-following on injected text remains model judgment, not mechanism; the association gate above closes the direct command channel, but content-borne injection is still worth keeping in mind when extending the PR hook or the connections.

## Development & testing

- **Runtime/TUI:** `pnpm dev` (eve dev TUI; `/model` links a provider).
- **Type checking:** `pnpm typecheck` (tsc).
- **Lint/format:** `pnpm check` / `pnpm fix` (Ultracite, a Biome preset; config in `biome.jsonc`).
- **Discovery diagnostics:** `npx eve info` (must report 0 errors / 0 warnings).
- There is no unit-test suite; verify behavior in the dev TUI.

## Future considerations

- Approval-gating outbound writes: Linear issue creation and email sends are ungated today because they are the agent's core loop; add per-connection `approval` policies if a human confirm step is wanted.
- Multi-repo digests: `DIGEST_REPO`/`DIGEST_EMAIL` are single values; supporting several repo/recipient pairs would mean one schedule per pair or a config list.
- Digest memory: tracking which issues were already reported (e.g. in Blob or Redis) so "new this week" is computed against the last digest rather than issue timestamps alone.
- A deterministic style checker (e.g. a banned-words lint reading the `writing-quality` references) to complement model judgment on outgoing prose.

## Glossary

- **eve:** the agent framework powering this app; discovers capabilities from `agent/`.
- **Channel:** an inbound/outbound surface. Here: GitHub, Linear, email (Resend via Chat SDK), plus the eve route's auth config.
- **Connection:** an external server (MCP/OpenAPI) exposed to the model; its tools are named `<connection>__<tool>`, found with `eve__search` and called with `eve__tool`. Here: `linear` and `resend`.
- **Tool:** a typed action authored with `defineTool` (or contributed by a mounted extension, like the `github__*` tools), run in the app runtime.
- **Schedule:** a cron-triggered session under `agent/schedules/`. Here: `weekly-digest`, a markdown task the agent completes by sending the digest through the resend connection.
- **Skill:** a load-on-demand Markdown procedure; the packaged form requires `description` frontmatter used for routing. Here: `writing-quality`, `digest-format`, `triaging-issues`, and `github-linear-bridging`.
- **Subagent:** a declared agent under `agent/subagents/<id>/` that the root delegates to as a tool (or, with `tool: false`, through an authored workflow tool's `ctx.agent()`). It runs in its own fresh child session and inherits none of the root's skills, connections, or tools, so the root passes context in the call `message`. Here: `researcher` (web research).
- **Vercel Connect:** brokers OAuth/credentials for GitHub and Linear; connectors are identified by a UID.
- **OIDC:** the project's Vercel identity token, used to authenticate Blob (and AI Gateway) without static keys.
