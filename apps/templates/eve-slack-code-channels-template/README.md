# Slack Code Channels

A coding agent template for [eve](https://eve.dev) that works in [Slack code channels](https://docs.slack.dev/ai/slack-code). Mention it in a thread with a coding or triage request, and it opens a code channel for the task, carries the conversation over, and does the work there in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

## How it works

The agent is the [coding agent template](../eve-coding-agent-template) with code channels turned on. Coding comes from eve's [code extension](https://eve.dev/docs/code-extension), and GitHub access from its companion git extension.

```txt
agent/
  agent.ts                              model, reasoning, compaction
  instructions.md                       identity, when to open a code channel, delivery
  sandbox.ts                            Vercel Sandbox with gh, git, and TypeScript tooling
  extensions/code.ts                    mounts eve/extensions/code
  extensions/git.ts                     mounts eve/extensions/git with Connect-brokered GitHub access
  lib/github.ts                         Connect connector and the firewall credential broker
  lib/code-channel.ts                   reads the sandbox and updates the context bar and diff view
  channels/slack.ts                     Slack with code channels and their context bar and diff view
  tools/open_code_channel.ts            moves a thread into a new code channel
  tools/update_code_channel_status.ts   reports pull request and test status
  tools/agent.ts                        disables the root agent copy (see below)
```

- **Code channels.** In a thread, the agent answers quick questions in place. For anything that needs a repository, it calls `open_code_channel`. The tool opens a code channel from the message, and Slack links it in the thread. The new channel's session starts with the thread's conversation. Everyone in the code channel can talk to the agent without mentioning it. The agent acknowledges each request and reports milestones as it works: a code channel has no thread status, so the Slack renderer posts the text the agent writes before a tool call.
- **Context bar and diff view.** After each tool that can change the workspace, the Slack channel's renderer reads every repository under `/workspace/repos/` in the sandbox. It shows the repository, branch, and number of changed files in the code channel's context bar, and every change against the base branch, untracked files included, in the channel's diff view. The agent reports what only it knows, the pull request and test status, with `update_code_channel_status`, which only code channels offer.
- **Tools.** The code extension adds `code__apply_patch` for edits and `code__grep` for search, next to eve's `bash`, `read_file`, and `write_file`. The git extension adds `git__gh` for authenticated GitHub commands.
- **Skills.** `code__investigate`, `code__review`, and `git__pr` load on demand.
- **Delegation.** `code__worker` is a read-only subagent for independent slices of a task. The root `agent` tool is disabled so all writes stay in one session.
- **Credentials.** Each `gh` command gets a token scoped to one repository, minted by [Vercel Connect](https://vercel.com/docs/connect). The sandbox only sees a placeholder. `lib/github.ts` swaps it in at the sandbox firewall for that command and removes it afterward.

## Getting started

Requires Node.js 24, pnpm, and the [Vercel CLI](https://vercel.com/docs/cli).

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

`vercel env pull` gives the sandbox and AI Gateway their credentials. Without `GITHUB_ORG` the agent has no `git__gh` tool and can't open pull requests.

## Connect Slack and GitHub

**Slack.** Run `eve add channel/slack`. It creates or picks a Slack app through Vercel Connect, routes its events to `/eve/v1/slack`, and writes the connector UID into `agent/channels/slack.ts`. Because the channel sets `codeChannels: true`, the generated app manifest enables Slack's code channels feature and adds its scopes and events. For an existing Connect connector, add the `code_channels:manage`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:read`, and `mpim:read` scopes and the `message.session` and `agent_session_stopped` events under **Advanced**.

**GitHub.** Create a GitHub connector for the `git__gh` tool:

```bash
vercel connect create github --name code-channels
```

Then set these in `.env.local` and your Vercel project:

- `GITHUB_ORG`: the organization or user whose repositories the agent may access
- `GITHUB_CONNECTOR`: the connector UID, if it is not `github/code-channels`

Deploy with `eve deploy`, then install the GitHub App on your repositories from the Connect dashboard and mention the app in Slack.

## Customize

- Change the model in `agent/agent.ts`.
- Edit `agent/instructions.md` to change when the agent opens a code channel. The extensions add their own coding guidance, so keep this file short.
- Change what the context bar shows in `agent/lib/code-channel.ts`. Slack shows at most five items.
- Add skills under `agent/skills/`, tools under `agent/tools/`, or override an extension contribution by name. See [Extensions](https://eve.dev/docs/extensions#override-a-contribution).

## Learn more

- [Slack channel](https://eve.dev/docs/channels/slack#serve-slack-code-channels) and [Slack code channels](https://docs.slack.dev/ai/slack-code)
- [Code extension](https://eve.dev/docs/code-extension)
- [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel)
