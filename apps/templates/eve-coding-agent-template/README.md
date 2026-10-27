# Coding Agent on Slack

A coding agent template for [eve](https://eve.dev). Mention it in Slack, or on a GitHub issue or pull request, and it investigates, reviews, or fixes code in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), then answers in the thread or opens a pull request. In Slack, it moves coding and triage work into a [code channel](https://docs.slack.dev/ai/slack-code) that shows the repository, branch, diff, pull request, and tests as it works.

## How it works

The coding capabilities come from eve's built-in [code extension](https://eve.dev/docs/code-extension), and GitHub access comes from its companion git extension. This template wires them to Slack and GitHub and keeps everything else default.

```txt
agent/
  agent.ts                              model and reasoning
  instructions.md                       identity, workspace, delivery
  instructions/code-channels.ts         when to open a code channel and how to work in one
  sandbox.ts                            Vercel Sandbox with gh, git, and TypeScript tooling
  extensions/code.ts                    mounts eve/extensions/code
  extensions/git.ts                     mounts eve/extensions/git with Connect-brokered GitHub access
  lib/github.ts                         Connect connector and the firewall credential broker
  lib/code-channel.ts                   the CODE_CHANNELS switch, and the context bar and diff view sync
  hooks/                                clears the checkout token before each GitHub turn's model call
  channels/slack.ts                     @mentions in Slack, plus code channels and their context bar and diff view
  channels/github.ts                    @coding-agent comments from trusted repository members
  tools/open_code_channel.ts            moves a Slack thread into a new code channel (wraps openCodeChannel())
  tools/update_code_channel_status.ts   reports pull request and test status
  tools/write_file.ts, tools/agent.ts   disable write_file and agent (see below)
```

- **Slack code channels.** In a Slack thread, the agent answers quick questions in place. For anything that needs a repository, it calls `open_code_channel`. The tool opens a code channel from the message, and Slack links it in the thread. The new channel's session starts with the thread's conversation. Everyone in the code channel can talk to the agent without mentioning it. The agent acknowledges each request and reports milestones as it works: a code channel has no thread status, so the Slack renderer posts the text the agent writes before a tool call.
- **Context bar and diff view.** After each tool that can change the workspace, the Slack channel's renderer reads every repository under `/workspace/repos/` in the sandbox. It shows the repository, branch, and number of changed files in the code channel's context bar, and every change against the base branch, untracked files included, in the channel's diff view. The agent reports what only it knows, the pull request and test status, with `update_code_channel_status`, which only code channels offer.
- **Tools.** The code extension adds `code__apply_patch` for edits and `code__grep` for search, next to eve's `bash` and `read_file`. The git extension adds `git__gh` for authenticated GitHub commands. `write_file` is disabled so edits go through `code__apply_patch` as small reviewable hunks.
- **Skills.** `code__investigate`, `code__review`, and `git__pr` load on demand.
- **Delegation.** `code__worker` is a read-only subagent for independent slices of a task. The root `agent` tool is disabled so all writes stay in one session.
- **Credentials.** Each `gh` command gets a token scoped to one repository, minted by [Vercel Connect](https://vercel.com/docs/connect). The sandbox only sees a placeholder. `lib/github.ts` swaps it in at the sandbox firewall for that command and removes it afterward. The GitHub channel's checkout attaches a broader token to `github.com`, so `hooks/reset-github-egress.ts` removes it before the model runs.
- **GitHub.** The triggering repository is checked out at `/workspace` before each GitHub turn, and pull request turns include the diff. Only comments from owners, members, and collaborators start a turn, so strangers on a public repository cannot drive the agent.

## Getting started

Requires Node.js 24, pnpm, and the [Vercel CLI](https://vercel.com/docs/cli).

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

`vercel env pull` gives the sandbox and AI Gateway their credentials. The dev UI opens a session with the agent. Without `GITHUB_ORG` the agent has no `git__gh` tool and can't open pull requests. The GitHub channel still answers mentions.

## Connect Slack and GitHub

**Slack.** Run `eve add channel/slack`. It creates or picks a Slack app through Vercel Connect, routes its events to `/eve/v1/slack`, and writes the connector UID into `agent/channels/slack.ts`. Because the channel sets `codeChannels`, the generated app manifest enables Slack's code channels feature and adds its scopes and events. For an existing Connect connector, add the `code_channels:manage`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:read`, and `mpim:read` scopes and the `message.session` and `agent_session_stopped` events under **Advanced**. To keep all Slack work in the thread, set `CODE_CHANNELS` to `false` in `agent/lib/code-channel.ts`. The agent then never opens a code channel, its instructions leave code channels out, and the generated manifest skips their scopes and events.

**GitHub.** Don't use `eve add channel/github` here. It stops with an error because `agent/channels/github.ts` already exists, and `--overwrite` replaces the file along with its rule that only repository owners, members, and collaborators can start a turn. Create the connector with the Vercel CLI instead:

```bash
vercel connect create github --name coding-agent --triggers \
  --trigger-event issue_comment --trigger-event pull_request_review_comment
vercel connect detach github/coding-agent --yes
vercel connect attach github/coding-agent --environment production \
  --triggers --trigger-path /eve/v1/github --yes
```

These are the commands `eve add channel/github` runs. `create` adds a default webhook destination without a path, so `detach` removes it before `attach` routes webhooks to `/eve/v1/github`.

Then set these in `.env.local` and your Vercel project:

- `GITHUB_ORG`: the organization or user whose repositories the agent may access
- `GITHUB_CONNECTOR`: the connector UID, if it is not `github/coding-agent`
- `GITHUB_BOT_NAME`: your GitHub App's slug, shown on the connector in the Connect dashboard

Deploy with `eve deploy`, then install the GitHub App on your repositories from the Connect dashboard. Mention the app in Slack, or comment `@<bot name> <request>` on an issue or pull request. Delete `agent/channels/github.ts` if you only want Slack; the agent still needs the GitHub connector and `GITHUB_ORG` to open pull requests.

## Customize

- Change the model in `agent/agent.ts`.
- Edit `agent/instructions.md` for tone and team conventions, and `agent/instructions/code-channels.ts` for when the agent opens a code channel. The extensions add their own coding guidance, so keep this file short.
- Change what the code channel's context bar shows in `agent/lib/code-channel.ts`. Slack shows at most five items.
- Add skills under `agent/skills/`, tools under `agent/tools/`, or override an extension contribution by name. See [Extensions](https://eve.dev/docs/extensions#override-a-contribution).
- The default HTTP channel accepts the eve TUI, Vercel OIDC, and local development. Add `agent/channels/eve.ts` to put your own auth in front of it. See [Auth and route protection](https://eve.dev/docs/guides/auth-and-route-protection).

## Learn more

- [Code extension](https://eve.dev/docs/code-extension)
- [Slack channel](https://eve.dev/docs/channels/slack), [Slack code channels](https://eve.dev/docs/channels/slack#serve-slack-code-channels), and [GitHub channel](https://eve.dev/docs/channels/github)
- [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel)
