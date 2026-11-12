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
  agent.ts                  # model selection
  instructions.md           # grounding, source routing, and Slack style
  instructions/             # how to connect each source; delete a note once it works
    github.ts
    linear.ts
    notion.ts
    pagerduty.ts
  channels/
    slack.ts                # mentions, DMs, followed threads, workspace gate
  connections/              # each on once its Vercel Connect connector exists
    linear.ts               # issues, projects, and cycles
    notion.ts               # wiki search and pages
    pagerduty.ts            # on-call and incidents
  extensions/
    code.ts                 # eve's code extension: files and code in a sandbox
    git.ts                  # eve's git extension: GitHub access and pull requests
  memory/
    channel.ts              # shared notes per Slack channel
    personal.ts             # private notes per person
  schedules/
    tasks.ts                # schedules people create by asking in Slack
  skills/
    company-context/
      SKILL.md              # fill in your teams, glossary, and sources
  tools/
    no_reply.ts             # lets the agent stay quiet in followed threads
    read_slack_conversation.ts # reads a public channel or thread
    search_slack.ts         # searches public Slack channels
  lib/
    connect.ts              # connector detection and setup notes
    conversation.ts         # tells private conversations from shared channels
    github.ts               # GitHub connector and firewall credential broker
    slack.ts                # shared Slack credentials and workspace check
  sandbox.ts                # Vercel Sandbox with coding tools installed
```

- **Evidence-based answers.** `instructions.md` has the agent answer
  company-specific questions only from sources it retrieved and cite them
  inline. `skills/company-context` is a stub to fill in with your teams,
  glossary, and sources.
- **Natural Slack behavior.** `channels/slack.ts` follows threads the agent is
  already in without a mention, and calls `no_reply` when a reply isn't for it.
  This needs extra Slack events; see [Get started](#get-started).
- **Slack search.** `tools/search_slack.ts` uses Slack's
  [Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api)
  to search public channels, and `tools/read_slack_conversation.ts` reads a
  public channel or thread the bot is in.
- **Workspace gate.** Guests, deactivated accounts, and, with `SLACK_TEAM_ID`
  set, people from other companies in Slack Connect channels can't start a
  conversation or answer approvals.
- **Memory.** Two [file memory](https://eve.dev/docs/memory/file) slots:
  `personal`, per person and only in private conversations, and `channel`, one
  shared document per Slack channel. See [Memory](#memory).
- **User-defined workflows.** `schedules/tasks.ts` lets people ask for recurring
  or one-time tasks. See [Scheduled tasks](#scheduled-tasks).
- **Code and GitHub.** The [code extension](https://eve.dev/docs/code-extension)
  and [git extension](https://eve.dev/docs/code-extension#publish-with-the-git-extension)
  run in a Vercel Sandbox, with GitHub App tokens scoped to one repository per
  command. See [Connect GitHub](#connect-github).
- **Optional connections.** The agent tells people how to connect Notion,
  Linear, PagerDuty, and GitHub until each one works. See
  [Connect a knowledge source](#connect-a-knowledge-source).

## Grow the brain

Start with `agent/skills/company-context/SKILL.md`. Replace the examples with
your teams, glossary, and where information lives. Until you do, the agent says
the company context hasn't been filled in.

Then add capabilities one at a time. After each one, ask the agent a question
the new capability should answer, and check that it picks the right source.

### Connect a knowledge source

Connections give the agent tools from an MCP server or an OpenAPI spec. The
template ships three sources, each off until its Vercel Connect connector
exists. Create the ones you use from the linked project:

```bash
vercel connect create notion --connection-method mcp --name company-brain
vercel connect create linear --connection-method mcp --name company-brain
vercel connect create pagerduty --connection-method mcp --name company-brain --data @pagerduty.json
```

- **Notion** (`agent/connections/notion.ts`): search and read pages.
- **Linear** (`agent/connections/linear.ts`): issues, projects, and cycles.
- **PagerDuty** (`agent/connections/pagerduty.ts`): on-call schedules,
  incidents, and services. Connect needs your own PagerDuty OAuth app: a
  PagerDuty admin registers one under **Integrations > Developer Tools > App
  Registration**, then saves its client ID and secret as `pagerduty.json`
  (`{ "clientId": "…", "clientSecret": "…" }`) for the command above.

Keep the name `company-brain`. It gives each connector the UID
`<service>/company-brain`, which the template looks for
(`agent/lib/connect.ts`). The agent picks up a new connector within a few
minutes, without a redeploy. Until then, the matching file in
`agent/instructions/` tells people who ask how to connect it. Delete a note once
its source works, and delete the connection or tool file of a source you don't
want.

For other sources, the eve registry has ready-made connections:

```bash
pnpm exec eve registry search docs       # find a connection
pnpm exec eve add connection/datadog     # writes agent/connections/datadog.ts
```

Connections connect through Vercel Connect. By default each person signs in with
their own account the first time the agent needs it, so the agent sees only what
that person can see. To share one service account with everyone instead, switch
the connection to app-scoped auth with `connect(uid, { principalType: "app" })`. Only do that
for content everyone who can reach the agent may read: the agent answers in
shared threads.

Write a precise `description` on each connection. The agent uses it to decide
which source owns a question. For a read-only knowledge source, also limit its
tools, as `agent/connections/notion.ts` does with
`tools: { allow: ["notion-search", "notion-fetch"] }`.

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

## Get started

The easiest way to start is the **Deploy with Vercel** button above. It creates
the Vercel project, the Slack connector, and the memory Blob store for you. To
set it up by hand instead:

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

GitHub is optional. Without it, the agent still runs code in its sandbox but
has no GitHub credentials, and it tells people who ask how to connect GitHub
(`agent/instructions/github.ts`). To connect it, create a Vercel Connect GitHub
connector from the linked project:

```bash
vercel connect create github --name company-brain
```

The name matters: it gives the connector the UID `github/company-brain`, which
the agent looks for, and the CLI attaches it to the linked project.

Install its GitHub App on the repositories the agent may use, from the Connect
dashboard. The agent can reach only those repositories. The agent notices the
connector within a few minutes, without a redeploy. To limit access to
repositories owned by one organization or user, for an app installed on more
than one account, set `GITHUB_ORG` in `.env.local` and the Vercel project and
redeploy.

Once GitHub works, delete `agent/instructions/github.ts`. It only tells the
agent how to point people to this setup.

Each `gh` command gets a GitHub App token scoped to one repository. The sandbox
only sees a placeholder; `lib/github.ts` swaps in the real token at the sandbox
firewall for that command and removes it afterward. The `authorize` callback in
`agent/extensions/git.ts` is the only access check: it allows Slack users in
your workspace, including their scheduled tasks, and, with `GITHUB_ORG` set,
only repositories that account owns. Tighten it if not everyone who can reach the agent should open
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

## Learn more

- [eve documentation](https://eve.dev/docs)
- [Slack channel reference](https://eve.dev/docs/channels/slack/reference)
- [Vercel Connect](https://vercel.com/kb/guide/vercel-connect)
