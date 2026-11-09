# Slack Company Brain Template

A starting point for a company-wide assistant in Slack, built with
[eve](https://eve.dev). People mention the agent in a channel or DM it, and it
answers in a thread. Out of the box it knows nothing about your company: you
grow it by adding sources (connections and tools), procedures (skills), and
specialists (subagents).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&project-name=slack-company-brain&repository-name=slack-company-brain&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fslack-company-brain-template)

## What's included

```text
agent/
  agent.ts                       # model selection
  instructions.md                # grounding, source routing, and Slack style
  instructions/github.ts         # how to connect GitHub; delete once connected
  channels/slack.ts              # mentions, DMs, followed threads, workspace gate
  extensions/code.ts             # eve's code extension: work with files and code in a sandbox
  extensions/git.ts              # eve's git extension: GitHub access and pull requests
  memory/personal.ts             # private notes per person, in DMs and outside Slack
  memory/channel.ts              # shared notes per Slack channel
  schedules/tasks.ts             # schedules people create by asking in Slack
  skills/company-context/SKILL.md # fill in your teams, glossary, and sources
  tools/no_reply.ts              # lets the agent stay quiet in followed threads
  tools/search_slack.ts          # searches public Slack channels
  tools/read_slack_conversation.ts # reads a public channel or thread
  sandbox.ts                     # Vercel Sandbox with coding tools installed
  lib/slack.ts                   # shared Slack credentials and workspace check
  lib/github.ts                  # GitHub connector and firewall credential broker
  lib/conversation.ts            # tells private conversations from shared channels
```

- **Grounded answers.** The instructions tell the agent to answer
  company-specific questions only from sources it retrieved, link the source
  inline, and say when nothing answers the question.
- **Thread context.** Each mention also sees the replies posted since the agent
  last spoke, with sender names.
- **Followed threads.** Once someone brings the agent into a thread, it sees
  later replies without a mention and answers only when a reply is meant for
  it. Otherwise it calls `no_reply` and leaves no trace. Top-level channel
  messages still need a mention. This needs extra Slack events; see
  [Get started](#get-started).
- **Slack search.** `search_slack` uses Slack's
  [Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api)
  to find relevant messages in public channels, best match first, with
  permalinks the agent cites, and `read_slack_conversation` reads a match's
  thread or a named channel. See [Slack search](#slack-search).
- **Workspace gate.** Workspace guests (multi- and single-channel) and
  deactivated accounts can't start a conversation or answer approvals and
  questions. The agent reads Slack with the bot's access, which reaches
  channels a guest can't see. With `SLACK_TEAM_ID` set, people from other
  companies in Slack Connect channels can't either.
- **Memory.** Two [file memory](https://eve.dev/docs/memory/file) slots: a
  private one per person, and a shared one per Slack channel. See
  [Memory](#memory).
- **Scheduled tasks.** People can ask for recurring or one-time work, such as
  "every Monday at 9, summarize last week's open questions here". Results post
  in the conversation where the schedule was created. See
  [Scheduled tasks](#scheduled-tasks).
- **Code and files.** The [code extension](https://eve.dev/docs/code-extension)
  lets the agent run scripts, analyze attached files such as CSVs or logs, and
  read or write code in a sandbox.
- **GitHub.** With `GITHUB_ORG` set, the [git extension](https://eve.dev/docs/code-extension#publish-with-the-git-extension)
  adds a `git__gh` tool for reading repositories, issues, and pull requests in
  that organization, and a `pr` skill for opening draft pull requests. See
  [Connect GitHub](#connect-github).
- **Built-in eve Slack behavior.** Threads are sessions, the thread status shows
  progress, and approvals and questions appear as buttons.

## Get started

```bash
pnpm install
vercel link                       # link a Vercel project
vercel connect create slack --name company-brain --triggers --trigger-path /eve/v1/slack
cp -n .env.example .env.local     # then set SLACK_CONNECTOR and SLACK_TEAM_ID
pnpm exec eve integration setup file-memory  # private Blob store for memory
vercel env pull                   # Vercel credentials for AI Gateway, sandbox, and memory
pnpm dev
```

`vercel connect create` creates the Slack app through Vercel Connect and
forwards its events to the linked project. Put the connector UID it prints in
`SLACK_CONNECTOR`. `cp -n` leaves an existing `.env.local` alone; add the
variables to it yourself in that case. Set `SLACK_CONNECTOR` and
`SLACK_TEAM_ID` in the Vercel project's environment too, then deploy:

```bash
pnpm exec eve deploy
```

To follow threads without a mention, the Slack app also needs the
`message.channels` event and `channels:history` scope (and `message.groups` and
`groups:history` for private channels). With Vercel Connect, add them in the
connector's **Advanced** settings under **Trigger Event Types** and **Bot
Scopes**. Without them, people mention the agent for each follow-up.

For Slack search and reading channels, also add the `search:read.public` and
`channels:read` bot scopes the same way.

Invite the app to a channel and mention it. Model calls use AI Gateway through
the linked project, or `AI_GATEWAY_API_KEY` in `.env.local`.

## Slack search

`agent/tools/search_slack.ts` calls Slack's `assistant.search.context` with the
app's bot token. It searches public channels only, even ones the agent hasn't
joined, and never private channels or DMs.

Slack only allows this with the short-lived `action_token` from the message
that started the turn, so search works in turns started by a mention or DM. It
doesn't work in scheduled tasks, followed-thread replies without a mention, or
non-Slack channels, and the token expires a few minutes after the message. The
tool tells the agent when search is unavailable so it reports the gap instead
of claiming nothing was found.

`agent/tools/read_slack_conversation.ts` reads one public channel's recent
messages, or one thread, with the bot token. It needs no action token, so it
also works in scheduled tasks, but Slack only lets the bot read channels it has
been invited to. It refuses private channels and DMs.

The Slack channel copies the token into each turn's auth as the `action_token`
attribute. That copy is a temporary workaround in `agent/channels/slack.ts`,
marked `WORKAROUND(vercel/eve#6088)`; a later eve release does it in
`defaultSlackAuth`.

## Memory

The agent keeps two kinds of notes, each a small document it edits with save
and remove tools:

| Slot       | Shared by                   | Available in                                    |
| ---------- | --------------------------- | ----------------------------------------------- |
| `personal` | One person                  | Slack DMs and non-Slack channels, such as `eve` |
| `channel`  | Everyone in a Slack channel | That channel's threads                          |

Personal memory is off in shared conversations, including group DMs, so notes
about one person never show up in a thread other people read. Channel memory
is off in DMs. Scopes come from the trusted Slack session in
`lib/conversation.ts`, never from the model. Personal memory follows the
signed-in identity, so someone's Slack DMs and their `eve` sessions keep
separate notes.

On Vercel, memory is stored in a private Vercel Blob store. The Deploy with
Vercel button creates one. Otherwise, run
`pnpm exec eve integration setup file-memory` once to create it and connect it to the
project, then redeploy. Without it, memory on Vercel reports an error that
points to that command. Under `eve dev`, memory lives in process memory and resets on
restart.

To change what gets remembered, edit the slot descriptions in `agent/memory/`
and the Memory section of `agent/instructions.md`. To search many records
instead of keeping a small document, swap `fileMemory()` for another
[provider](https://eve.dev/docs/memory#choose-a-provider) without changing the
scopes.

## Connect GitHub

GitHub is optional. Without `GITHUB_ORG`, the agent still runs code in its
sandbox but has no GitHub credentials, and it tells people who ask how to
connect GitHub (`agent/instructions/github.ts`). To enable it, create a Vercel Connect
GitHub connector:

```bash
vercel connect create github --name company-brain
```

Install its GitHub App on the repositories the agent may use, from the Connect
dashboard. Then set these in `.env.local` and the Vercel project:

- `GITHUB_ORG`: the organization or user whose repositories the agent may access
- `GITHUB_CONNECTOR`: the connector UID, if it isn't `github/company-brain`

Redeploy, then delete `agent/instructions/github.ts`. It only tells the agent
how to point people to this setup, and says nothing once `GITHUB_ORG` is set.

Each `gh` command gets a GitHub App token scoped to one repository. The sandbox
only sees a placeholder; `lib/github.ts` swaps in the real token at the sandbox
firewall for that command and removes it afterward. The `authorize` callback in
`agent/extensions/git.ts` is the only access check: it allows Slack users in
your workspace, including their scheduled tasks, and only repositories owned by
`GITHUB_ORG`. Tighten it if not everyone who can reach the agent should open
pull requests.

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
  run, `auth` checks with Slack that the account is still an active full
  member, not a guest, and, with `SLACK_TEAM_ID` set, still in your workspace.
  For a private channel or group DM, it also checks that the creator is still
  in it. That check needs the `groups:read` and `mpim:read` bot scopes.
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
you mount under `agent/extensions/`. This template already mounts
`eve/extensions/code` and `eve/extensions/git`. Delete their files under
`agent/extensions/` (and `agent/sandbox.ts`) if your brain shouldn't run code.
Browse more with `pnpm exec eve registry list`. See
[Extensions](https://eve.dev/docs/extensions).

### Change Slack behavior

`agent/channels/slack.ts` decides who reaches the agent and what each message
carries. The Slack docs cover common next steps:

- [Join new conversations](https://eve.dev/docs/channels/slack#reply-without-a-mention)
  in channels you choose, using a decision model to screen messages.
- [Restrict access](https://eve.dev/docs/channels/slack#restrict-access) to
  specific people or channels.
- [Start conversations proactively](https://eve.dev/docs/channels/slack#start-conversations-proactively)
  from a schedule, such as a weekly digest.
- [Customize rendering](https://eve.dev/docs/channels/slack#customize-rendering)
  of replies and approval cards.

## Before you roll it out

- **Shared threads are public to their members.** Anything the agent retrieves
  can appear in a thread other people read. Prefer per-person auth for
  connections, and use app-scoped auth only for content everyone may see.
- **Set `SLACK_TEAM_ID`.** Without it, full members of other workspaces in
  Slack Connect channels can start a conversation or answer an approval.
  Workspace guests are always refused.
- **The sandbox has open egress.** Like eve's coding agent template, code the
  agent runs can reach any host; only GitHub credentials are held back at the
  firewall. Don't put other credentials in the sandbox, and narrow the network
  policy in `agent/sandbox.ts` and `lib/github.ts` if you need to restrict
  egress. See [Sandbox](https://eve.dev/docs/sandbox).
- **Channel memory is shared.** Anyone who can reach the agent in a channel
  benefits from, and can add to, that channel's notes. Review the channel
  memory description if your channels hold sensitive discussions.
- **Keep checks in sensitive tools.** The channel gate decides who can start a
  turn or answer an approval. A tool that reads or changes sensitive data should check
  `ctx.session.auth` itself.

## Learn more

- [eve documentation](https://eve.dev/docs)
- [Slack channel reference](https://eve.dev/docs/channels/slack/reference)
- [Vercel Connect](https://vercel.com/kb/guide/vercel-connect)
