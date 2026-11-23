# Slack company brain

This project is an eve agent that people reach in Slack. Before writing code,
read the relevant guide in `node_modules/eve/dist/docs/public/`.

## Layout

- `agent/instructions.md`: the root prompt. Keep it about behavior that applies
  to every turn: grounding, citations, source routing and handoffs, response
  length, and Slack style.
- `agent/instructions/{github,notion,linear,pagerduty}.ts`: until the matching
  `<service>/company-brain` connector is attached, tell the agent that source
  isn't connected and give the `vercel connect create` command. Delete each
  once its source works.
- `agent/connections/{notion,linear,pagerduty}.ts`: turn on once their
  connectors are attached. Detection and setup notes live in
  `agent/lib/connect.ts`.
- `agent/channels/slack.ts`: who can reach the agent and what context each
  message carries.
- `agent/channels/eve.ts`: eve's HTTP API. Grants tool stubs only to
  `localDev()` callers, for `evals/`; production keeps eve's default auth.
- `evals/`: `eve eval` checks for the reply rules in `instructions.md`, run on
  the real model with Slack tools stubbed. `evals/lib/slack.ts` builds
  messages in the Slack channel's model format, since evals run over HTTP.
  Keep its guidance text in sync with `FOLLOWED_THREAD_GUIDANCE` in
  `agent/channels/slack.ts`, and its scheduled-run message in sync with `run`
  in `agent/schedules/tasks.ts`.
- `agent/schedules/tasks.ts`: schedules people create by asking in Slack
  (experimental `defineDynamicSchedules`). The destination and creator come
  from the Slack session in `preparePayload`, never from the model.
- `agent/extensions/code.ts` and `agent/extensions/git.ts`: eve's code and git
  extensions, for running code in the Vercel Sandbox (`agent/sandbox.ts`) and,
  with the `github/company-brain` connector, GitHub access through `git__gh`. The `authorize`
  callback in `git.ts` is the only access check on GitHub commands.
- `agent/extensions/skills.ts`: eve's experimental custom skills extension.
  People save their own versioned skills by asking: personal ones follow them
  everywhere, and channel ones apply to everyone in a Slack channel once
  their author approves them. Stored in memory's Blob store; scopes come from
  the trusted session, never from model input.
- `agent/memory/`: two file memory slots. `personal` is per person and only
  on in private conversations; `channel` is per Slack channel. Scopes come from
  `agent/lib/conversation.ts`, never from model input.
- `agent/tools/search_slack.ts`: Slack's Real-time Search API, public channels
  only. It reads the `action_token` auth attribute that eve's `defaultSlackAuth`
  sets in `agent/channels/slack.ts`.
  `agent/tools/read_slack_conversation.ts` reads a public channel or thread the
  bot is in. `agent/tools/post_slack_file.ts` uploads a sandbox file to the
  session's own Slack thread, taken from channel metadata, never model input.
  All three use `callSlack` from `agent/lib/slack.ts`.
- `agent/skills/`: procedures and reference material loaded on demand.
- `agent/connections/`, `agent/tools/`, `agent/subagents/`, `agent/extensions/`:
  added as the brain grows. Names come from file paths.

## Extending

- Add a knowledge source as a connection (see `agent/connections/notion.ts`,
  or `eve add connection/<name>`) or a tool, not by pasting its content into
  instructions.
- Give a group of related sources its own subagent when it needs its own
  prompt, tools, or model. Write the subagent's `description` as a routing
  contract: what it owns, example questions, what to pass it, what it returns,
  and what it is not for. The root agent routes from that text alone.
- Put company facts in `agent/skills/company-context/`, not in
  `instructions.md`.
- When you change reply behavior in `instructions.md`, add or update an eval
  under `evals/` and run it with `pnpm eval <dir> --repeat 3`.
- Keep access checks in `agent/channels/slack.ts` and inside any tool that
  reads or writes sensitive data.
