# Slack Company Brain Template

A starting point for a company-wide assistant in Slack, built with
[eve](https://eve.dev). People mention the agent in a channel or DM it, and it
answers in a thread. Out of the box it knows nothing about your company: you
grow it by adding sources (connections and tools), procedures (skills), and
specialists (subagents).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&project-name=slack-company-brain&repository-name=slack-company-brain&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fslack-company-brain-template)

## What's included

```text
agent/
  agent.ts                       # model selection
  instructions.md                # grounding, source routing, and Slack style
  channels/slack.ts              # mentions and DMs, thread context, workspace gate
  schedules/tasks.ts             # schedules people create by asking in Slack
  skills/company-context/SKILL.md # fill in your teams, glossary, and sources
  lib/slack.ts                   # shared Slack credentials and workspace check
```

- **Grounded answers.** The instructions tell the agent to answer
  company-specific questions only from sources it retrieved, link the source
  inline, and say when nothing answers the question.
- **Thread context.** Each mention also sees the replies posted since the agent
  last spoke, with sender names.
- **Workspace gate.** With `SLACK_TEAM_ID` set, only members of your workspace
  can start a conversation, so guests in Slack Connect channels can't.
- **Scheduled tasks.** People can ask for recurring or one-time work, such as
  "every Monday at 9, summarize last week's open questions here". Results post
  in the conversation where the schedule was created. See
  [Scheduled tasks](#scheduled-tasks).
- **Built-in eve Slack behavior.** Threads are sessions, the thread status shows
  progress, and approvals and questions appear as buttons.

## Get started

```bash
pnpm install
pnpm exec eve add channel/slack   # creates the Slack app through Vercel Connect
cp .env.example .env.local        # then set SLACK_TEAM_ID
pnpm dev
```

`eve add channel/slack` links a Vercel project, creates or reuses a Slack app,
and asks you to install it. If it offers to replace `agent/channels/slack.ts`,
keep this template's version. Set `SLACK_CONNECTOR` and `SLACK_TEAM_ID` in the
Vercel project's environment too, then deploy:

```bash
pnpm exec eve deploy
```

Invite the app to a channel and mention it. Model calls use AI Gateway through
the linked project, or `AI_GATEWAY_API_KEY` in `.env.local`.

## Scheduled tasks

`agent/schedules/tasks.ts` uses eve's experimental
[dynamic schedules](https://eve.dev/docs/experimental/dynamic-schedules). It
gives the agent `schedule__tasks__create`, `list`, `update`, `delete`, and
related tools, so people manage schedules by asking:

> @brain every weekday at 9am Pacific, post a summary of yesterday's open
> questions in this channel
>
> @brain remind me in this thread in 2 hours to check the deploy
>
> @brain what schedules do I have?

How it works:

- **Where results go.** `preparePayload` saves the Slack conversation the
  request came from (and the thread, for "reply here" requests) from the trusted
  Slack session. The model can't choose another destination. Create a schedule
  from a DM to get results in that DM.
- **Who it runs as.** Each run is a new session that runs as the person who
  created the schedule, so per-person connections use their access. Before each
  run, `auth` checks with Slack that the account is still active and, with
  `SLACK_TEAM_ID` set, still in your workspace.
- **Who can manage it.** Each person sees and changes only their own schedules.
  Creating or changing one asks for approval in Slack first. Set `approval` in
  the definition to change that.
- **No one is present.** Scheduled runs can't wait for questions or approvals,
  so the task text has to be complete, and tools that need approval can't wait for it.

On Vercel, Vercel Schedules stores and fires schedules. Preview and production
schedules are separate. Under `eve dev` schedules are stored in memory and never
fire on their own; ask the agent to run one now (`invoke`) to test it.

To add another kind of schedule, such as one that always posts to a fixed team
channel, add another file under `agent/schedules/` with its own `inputSchema`
and `preparePayload`.

## Grow the brain

Start with `agent/skills/company-context/SKILL.md`. Replace the examples with
your teams, glossary, and where information lives. Until you do, the agent says
the company context hasn't been filled in.

Then add capabilities one at a time. After each one, ask the agent a question
the new capability should answer, and check that it picks the right source.

### Connect a knowledge source

Connections give the agent tools from an MCP server or an OpenAPI spec. The eve
registry has ready-made ones for common workplace tools:

```bash
pnpm exec eve registry search docs       # find a connection
pnpm exec eve add connection/notion      # writes agent/connections/notion.ts
pnpm exec eve add connection/linear
```

These connect through Vercel Connect. By default each person signs in with
their own account the first time the agent needs it, so the agent sees only what
that person can see. To share one service account with everyone instead, switch
the connection to app-scoped auth (the generated file shows how). Only do that
for content everyone who can reach the agent may read: the agent answers in
shared threads.

Write a precise `description` on each connection. The agent uses it to decide
which source owns a question. For a read-only knowledge source, also limit its
tools:

```ts title="agent/connections/notion.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description:
    "Company wiki: policies, runbooks, specs, and project pages. Not for Slack discussions.",
  auth: connect("notion"),
  tools: { allow: ["notion-search", "notion-fetch"] },
});
```

See [Connections](https://eve.dev/docs/connections) and
[Add Integrations](https://eve.dev/docs/install-integrations).

### Add a skill

A skill is a procedure the agent loads only when a task needs it, such as "how
we answer access requests" or "how to summarize an incident". Add a markdown
file under `agent/skills/`:

```md title="agent/skills/access-requests/SKILL.md"
---
description: How to answer requests for access to tools and systems.
---

1. Ask which system and what level of access the person needs.
2. Look up the owning team in company-context.
3. ...
```

You can also install published skills with `eve add`. See
[Skills](https://eve.dev/docs/skills).

### Add a specialist subagent

When a domain needs its own prompt, tools, or model, give it a subagent. The
root agent sees only the subagent's `description`, so write it as a routing
contract:

```ts title="agent/subagents/support/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  description:
    "Support specialist. Owns: customer tickets, escalation status, and known issues. " +
    'Use for: "what is the status of ticket 123?", "has anyone reported X?". ' +
    "Pass: ticket IDs, customer names, and absolute dates. " +
    "Returns: findings with links to the tickets it read. " +
    "Not for: internal policies (use the wiki) or engineering roadmaps.",
});
```

Put the subagent's own `instructions.md`, `connections/`, `tools/`, and
`skills/` in its directory, so only it carries them. Subagents never see the
parent conversation, so tell them in their instructions that the message they
receive is the whole task. See [Subagents](https://eve.dev/docs/subagents).

### Add a tool

Write a tool when you need logic that no connection provides, such as calling
an internal API. Add a file under `agent/tools/`; its name comes from the file
name. See [Tools](https://eve.dev/docs/tools).

### Mount an extension

Extensions bundle tools, skills, subagents, and instructions into one package
you mount under `agent/extensions/`. eve ships some, such as
`eve/extensions/code` for working in a sandbox. Browse more with
`pnpm exec eve registry list`. See [Extensions](https://eve.dev/docs/extensions).

### Change Slack behavior

`agent/channels/slack.ts` decides who reaches the agent and what each message
carries. The Slack docs cover common next steps:

- [Reply without a mention](https://eve.dev/docs/channels/slack#reply-without-a-mention)
  in threads the agent is already in.
- [Restrict access](https://eve.dev/docs/channels/slack#restrict-access) to
  specific people or channels.
- [Start conversations proactively](https://eve.dev/docs/channels/slack#start-conversations-proactively)
  from a schedule, such as a weekly digest.
- [Customize rendering](https://eve.dev/docs/channels/slack#customize-rendering)
  of replies and approval cards.

To let the agent remember things between conversations, add a memory provider,
such as `pnpm exec eve add memory/file`. See [Memory](https://eve.dev/docs/memory).

## Before you roll it out

- **Shared threads are public to their members.** Anything the agent retrieves
  can appear in a thread other people read. Prefer per-person auth for
  connections, and use app-scoped auth only for content everyone may see.
- **Set `SLACK_TEAM_ID`.** Without it, anyone Slack delivers a message from,
  including Slack Connect guests, can start a conversation.
- **Keep checks in sensitive tools.** The channel gate decides who can start a
  turn. A tool that reads or changes sensitive data should check
  `ctx.session.auth` itself.

## Learn more

- [eve documentation](https://eve.dev/docs)
- [Slack channel reference](https://eve.dev/docs/channels/slack/reference)
- [Vercel Connect](https://vercel.com/kb/guide/vercel-connect)
