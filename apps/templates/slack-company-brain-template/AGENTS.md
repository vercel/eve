# Slack company brain

This project is an eve agent that people reach in Slack. Before writing code,
read the relevant guide in `node_modules/eve/dist/docs/public/`.

## Layout

- `agent/instructions.md`: the root prompt. Keep it about behavior that applies
  to every turn: grounding, source routing, and Slack style.
- `agent/channels/slack.ts`: who can reach the agent and what context each
  message carries.
- `agent/schedules/tasks.ts`: schedules people create by asking in Slack
  (experimental `defineDynamicSchedules`). The destination and creator come
  from the Slack session in `preparePayload`, never from the model.
- `agent/extensions/code.ts` and `agent/extensions/git.ts`: eve's code and git
  extensions, for running code in the Vercel Sandbox (`agent/sandbox.ts`) and,
  with `GITHUB_ORG` set, GitHub access through `git__gh`. The `authorize`
  callback in `git.ts` is the only access check on GitHub commands.
- `agent/memory/`: two file memory slots. `personal` is per person and only
  on in private conversations; `channel` is per Slack channel. Scopes come from
  `agent/lib/conversation.ts`, never from model input.
- `agent/skills/`: procedures and reference material loaded on demand.
- `agent/connections/`, `agent/tools/`, `agent/subagents/`, `agent/extensions/`:
  added as the brain grows. Names come from file paths.

## Extending

- Add a knowledge source as a connection (`eve add connection/<name>`) or a
  tool, not by pasting its content into instructions.
- Give a group of related sources its own subagent when it needs its own
  prompt, tools, or model. Write the subagent's `description` as a routing
  contract: what it owns, example questions, what to pass it, what it returns,
  and what it is not for. The root agent routes from that text alone.
- Put company facts in `agent/skills/company-context/`, not in
  `instructions.md`.
- Keep access checks in `agent/channels/slack.ts` and inside any tool that
  reads or writes sensitive data.
