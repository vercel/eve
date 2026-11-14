# Kody (GitHub Maintainer) eve Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Kody is a personal GitHub maintainer agent built on [eve](https://eve.dev), made for freelancers, solo maintainers, and anyone who runs a repo alongside everything else. Every Monday it emails you a digest of your repo's open issues. Between digests it answers authorized maintainer @mentions on the configured repo and handles the Linear issues you delegate. Inbound email commands and automatic PR-open summaries are intentionally disabled.

- **Digests your issue tracker weekly.** A cron schedule fetches all open issues on your repo, groups them (needs attention, recent activity, stale), cites every issue as #N, and sends the digest by email through the Resend MCP tools.
- **Works in Linear.** Delegate issues to the agent or mention it in Linear Agent Sessions ("email me a summary of this issue"), and it works the issue with the Linear MCP tools.
- **Answers authorized GitHub mentions.** @Kody on an issue or PR in `DIGEST_REPO` gets an in-thread reply only after GitHub confirms the caller has write, maintain, or admin permission there. Roles on unrelated repositories do not grant access to the shared integrations.
- **Remembers your preferences.** Standing preferences (a preferred email address, how you like the digest grouped, a default Linear team) live in Vercel Blob, keyed to the resolved principal.

## Deploy

### Disabled inbound surfaces

Inbound email commands are intentionally disabled by default pending a separately authenticated authorization protocol. `/eve/v1/resend` rejects every POST with HTTP 403 without parsing mail or dispatching a session, including replies to previously subscribed threads. There is no opt-in switch or exported email dispatch helper. Outbound weekly digests still use the Resend MCP connection.

A signed Resend webhook proves delivery, not permission to use shared Linear and Resend credentials. Re-enabling email commands requires separately authenticated authorization bound to this installation. A `From` allowlist, matching `DIGEST_EMAIL`, thread headers, or approval prompts alone are not sufficient. Existing installations should remove inbound webhook delivery and queued retries.

Automatic PR-open summaries are also disabled pending an isolated read-only agent and a bounded publisher. Authorized maintainers can request summaries through @Kody mentions on `DIGEST_REPO`. Configure that repository only for maintainers you trust with this installation's shared GitHub, Linear, and Resend authority; GitHub permission is not per-user Linear consent.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?project-name=kody-eve-template&repository-name=kody-eve-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fkody-eve-template&env=RESEND_API_KEY,RESEND_WEBHOOK_SECRET,RESEND_FROM_ADDRESS,DIGEST_REPO,DIGEST_EMAIL&envDescription=Resend%20API%20key%20%2B%20inbound%20webhook%20secret%2C%20a%20verified%20sender%20address%2C%20and%20the%20digest%20repo%2Frecipient.&connect=%5B%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fgithub%22%7D%2C%7B%22type%22%3A%22linear%22%2C%22env%22%3A%22LINEAR_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinear%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D)

The button deploys the upstream repository, not this secured copy. Its provisioning includes:

- a **GitHub** connector (sets `GITHUB_CONNECTOR`, with the trigger pointed at `/eve/v1/github`),
- a **Linear** connector (sets `LINEAR_CONNECTOR`, with the trigger pointed at `/eve/v1/linear`),
- a **Vercel Blob** store for the preference tools,
- an **Upstash Redis** store (sets `REDIS_URL`) for the email channel's thread state,
- prompts for the Resend API key, webhook secret, sender address, and digest repo and recipient.

The button still targets the upstream template, not this imported copy. Deploy this copy with `eve deploy` to use these security defaults. Its inbound email route rejects all requests; do not configure an inbound webhook. Redis and the inbound webhook secret provisioned by the upstream button are not needed by this copy.

To set things up by hand instead, deploy with `eve deploy` (it wraps `vercel deploy --prod`; the raw command cannot auto-detect the eve framework) and provision the integrations first:

### GitHub and Linear connectors

Create the connectors with the [Vercel CLI](https://vercel.com/docs/cli) and point their triggers at the routes the agent serves:

```bash
# GitHub connector (UID -> GITHUB_CONNECTOR); subscribe to issue_comment and
# pull_request_review_comment during registration for mention-driven turns
vercel connect create github --triggers
vercel connect attach <github-uid> --triggers --trigger-path /eve/v1/github --yes

# Linear connector (UID -> LINEAR_CONNECTOR); subscribe to the AgentSessionEvent
# webhook category during registration
vercel connect create linear --triggers
vercel connect attach <linear-uid> --triggers --trigger-path /eve/v1/linear --yes
```

Set `GITHUB_CONNECTOR` and `LINEAR_CONNECTOR` to the printed UIDs in the project's environment.

### Resend

Set `RESEND_API_KEY` for outbound digests and `RESEND_FROM_ADDRESS` to a verified sender on your Resend domain. Optionally set `RESEND_FROM_NAME` (defaults to "Kody"). The system prompt and schedule use these sender settings. No inbound webhook secret or Redis store is needed: email replies are not processed.

### Blob and digest config

- `DIGEST_REPO` also binds GitHub mention authorization. Permission lookup errors deny dispatch; a historical `author_association` is not sufficient.
- A private Vercel Blob store connected to the project, for the preference tools: `vercel blob create-store <name> --access private --yes`. Existing public stores must be replaced; delete old public preference objects because changing the app does not revoke their URLs.
- `DIGEST_REPO` (e.g. `owner/repo`) and `DIGEST_EMAIL`: what the weekly digest covers and who receives it. Both are required at build time; a missing value fails discovery with a clear error instead of deploying a digest that cannot send.

## Tech stack

| Layer                  | Technology                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent framework        | [eve](https://eve.dev)                                                                                                                                                          |
| Language               | TypeScript (strict, ESM)                                                                                                                                                        |
| GitHub surface & tools | eve GitHub channel + [GitHub Tools eve extension](https://github-tools.com/frameworks/eve-extension) (maintainer preset), via [Vercel Connect](https://vercel.com/docs/connect) |
| Linear surface & tools | eve Linear channel (Agent Sessions) via [Vercel Connect](https://vercel.com/docs/connect) + Linear MCP                                                                          |
| Email inbound          | Disabled; the legacy Resend route rejects all POSTs                                                                                                                             |
| Email sending          | Resend MCP (`mcp.resend.com`)                                                                                                                                                   |
| Preference storage     | [Vercel Blob](https://vercel.com/docs/vercel-blob)                                                                                                                              |
| Model access           | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)                                                                                                                         |
| Sandbox                | [Vercel Sandbox](https://vercel.com/docs/sandbox)                                                                                                                               |
| Lint & format          | [Ultracite](https://www.ultracite.ai/) (Biome)                                                                                                                                  |

GitHub and Linear credentials are brokered by [Vercel Connect](https://vercel.com/docs/connect); Blob and the model authenticate with the project's [Vercel OIDC](https://vercel.com/docs/oidc) token. The only required static credential is the outbound Resend API key.

## Quick start with an AI coding agent

If you're working with an AI coding agent like Claude Code or Cursor, you can use this prompt to have it help you with building your agent:

```text
I want to build a GitHub maintainer agent with the eve framework, using the Kody template. Read the setup instructions at https://agent-resources.dev/kody-eve-template.md and follow them. They will cover deploying the template, building with eve, how everything works overall, and more.
```

## What's inside

```text
agent/
  agent.ts                  # model configuration, compaction, session usage limit
  instructions.ts           # the agent's behavior; compiled at build time with RESEND_FROM_ADDRESS baked in
  channels/
    github.ts               # repo-bound, API-verified maintainer @mentions; no automatic PR summaries
    linear.ts               # eve Linear Channel
    resend.ts               # rejects all inbound email with HTTP 403
    eve.ts                  # dev TUI / route auth surface
  connections/
    linear.ts               # Linear MCP, app-scoped Connect auth via linearAuth
    resend.ts               # Resend MCP, static bearer token from RESEND_API_KEY
  schedules/
    weekly-digest.ts        # cron "0 9 * * 1" (Mondays 09:00 UTC); the agent composes and sends the digest
  sandbox.ts                # Vercel Sandbox environment
  subagents/
    researcher/             # fresh-context web researcher (own session, web tools only)
  extensions/
    github.ts               # GitHub Tools eve extension: read and triage issues on the repo (github__* tools)
  tools/
    research.ts             # workflow tool: asks the researcher for cited findings (structured output)
    get_user_preferences.ts   # load this user's saved preferences
    save_user_preferences.ts  # save standing preferences (per-user, principal-scoped)
    clear_user_preferences.ts # clear this user's preferences (requires approval)
  lib/
    constants.ts            # requireEnv + shared app-scoped Linear authorization
    user-preferences.ts     # principal-scoped Blob key + reserved-prefix guard
  skills/
    writing-quality/        # prose rules for anything written for humans
    digest-format/          # the weekly digest's structure: grouping, criteria, one-line summaries
    triaging-issues/        # triage playbook: dedupe, repo labels, ask-or-close, repro requests
    github-linear-bridging/ # bridged Linear issues and two-way cross-links
```

## Pairing with the content agent template

The [eve content agent template](https://github.com/vercel-labs/eve-content-agent-template) is a full content assistant: per-surface style skills (blog, LinkedIn, X, release notes, newsletters), a house voice, and a style lint. Instead of merging all of that into Kody, you can deploy it as its own agent and let Kody delegate to it, through eve's [remote agents](https://eve.dev/docs/guides/remote-agents) feature, when repo work turns into writing work: release notes for a shipped fix, or a post announcing a feature that just closed out.

1. Deploy the content agent template as its own Vercel project.
2. Add a remote subagent file to this repo. The filename is the tool name, and `vercelOidc()` handles deployment-to-deployment auth with no shared secret:

```ts
// agent/subagents/content_writer.ts
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: () =>
    process.env.CONTENT_AGENT_URL ?? "https://your-content-agent.vercel.app",
  description:
    "Drafts blog posts, LinkedIn and X posts, release notes, and newsletters in the house voice. " +
    "Pass the surface, the source material, and any constraints in the message.",
  auth: vercelOidc(),
});
```

3. Set `CONTENT_AGENT_URL` in this project's environment and mention the new subagent in `agent/instructions.ts` so Kody knows when to hand off.

The remote agent runs in its own deployment with its own skills and connections, and it never sees Kody's conversation history, so Kody packs everything the writer needs into the call `message`: the issues or PRs the piece covers, the audience, and the surface. Like any subagent call, it runs as a task: Kody gets a receipt right away and the writer's reply arrives as the task's result.

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

You can chat with the agent directly in the dev TUI to exercise the GitHub tools, the Linear and Resend connections, and the preference tools. The supported webhook surfaces (authorized GitHub mentions and Linear sessions) run against a deployment. Email replies are not processed.

`eve dev` never fires schedules on their cron cadence. Trigger the digest by hand with the dev dispatch route:

```bash
curl -X POST http://localhost:2000/eve/v1/dev/schedules/weekly-digest
```

`pnpm build` prepares the Vercel Sandbox snapshot, so a local build needs the linked project's credentials (`vercel env pull`); deployments on Vercel have them automatically. Use `eve build --skip-sandbox-prewarm` to check that the app compiles without them (that output is not deployable).

Ship changes with:

```bash
eve deploy
```

### Linting and formatting

This project uses [Ultracite](https://www.ultracite.ai/) (a [Biome](https://biomejs.dev/) preset) for linting and formatting:

```bash
pnpm check      # check formatting and lint rules
pnpm fix        # auto-fix what is fixable
pnpm validate   # lint + typecheck + eve discovery diagnostics
```

## Customizing

- **Behavior:** edit `agent/instructions.ts`. It describes the whole workflow: ground everything in the real tracker, the outbound weekly digest, Linear sessions, and authorized GitHub mentions. The sending-email rule resolves `RESEND_FROM_ADDRESS` at build time.
- **The digest:** the cron expression, subject line, and recipient live in `agent/schedules/weekly-digest.ts`; the digest's structure (grouping, needs-attention and stale criteria, one-line summaries) lives in `agent/skills/digest-format/SKILL.md`.
- **PR summaries:** automatic dispatch is disabled. Do not re-enable it on the privileged root agent; use an isolated read-only agent and a bounded host-side publisher.
- **Approval gates:** `agent/extensions/github.ts` sets `requireApproval: "never"` for the reversible issue-conversation writes for authorized maintainer workflows; adjust the list to re-gate them. `clear_user_preferences` stays approval-gated.
- **Skills:** edit or add skills in `agent/skills/`. Each folder holds a `SKILL.md` plus its reference files.
- **Model:** edit `agent/agent.ts` (or run `/model` in the dev TUI).
- **Tools:** add or change tools in `agent/tools/`. The filename is the tool name.

The agent auto-updates as you edit these files.

## Learn more

- [eve documentation](https://eve.dev/docs/introduction): the framework powering this agent.
- [Vercel Connect](https://vercel.com/docs/connect): manages the GitHub and Linear credentials.
- [Resend](https://resend.com/docs): email sending and inbound webhooks.
- [Vercel Blob](https://vercel.com/docs/vercel-blob): object storage for the preference tools.

## Related templates

- [eve Content Agent](https://github.com/vercel-labs/eve-content-agent-template)
- [eve Personal Agent](https://vercel.com/templates/nuxt/eve-personal-agent)
