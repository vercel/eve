# Coding Agent in Slack Code Channels

A coding agent template for [eve](https://eve.dev) that works in [Slack code channels](https://docs.slack.dev/ai/slack-code). Ask it in any thread to "open a code channel", and it opens a temporary channel for the task, works in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), shows its diff on the channel's diff tab, and links the branch and pull request in the context bar. Anyone in the channel can follow along and steer it without mentioning it.

## How it works

```txt
agent/
  agent.ts                      model, reasoning, compaction
  instructions.md               identity and code channel conventions
  sandbox.ts                    Vercel Sandbox with gh, git, and TypeScript tooling
  extensions/code.ts            mounts eve/extensions/code
  extensions/git.ts             mounts eve/extensions/git with Connect-brokered GitHub access
  lib/github.ts                 Connect connector and the firewall credential broker
  lib/code-channels.ts          detection, creation, and one session per code channel
  lib/slack.ts                  Slack API access for tools
  channels/slack.ts             mentions, code channel messages, and code channel rendering
  tools/publish_diff.ts         git diff -> the channel's diff tab and context bar
  tools/set_context_bar.ts      repository, branch, pull request, and preview links
  tools/archive_code_channel.ts closing summary, then archive
  tools/                        also disables write_file and agent, as in the coding agent template
```

Files shared with the [coding agent template](../eve-coding-agent-template), such as the extensions, sandbox, and GitHub broker, are copied from it by `pnpm sync:template-files`. Edit them there.

1. **Opening a channel.** When a mention asks for a code channel, `onAppMention` calls `agents.conversations.create` with the requesting message as the origin, before the agent runs. The first turn starts in the new channel with the request and the earlier thread messages as context. If Slack refuses, for example because Slack Code isn't enabled for the workspace, the agent answers in the thread instead. Other mentions behave like the [coding agent template](../eve-coding-agent-template).
2. **One session per channel.** A code channel is one task, but eve gives each Slack thread its own session. `withCodeChannelSessions` sends every turn from a code channel to a single channel-wide session instead. Code channels people open from Slack's own UI with this agent selected are detected with `conversations.info` and handled the same way.
3. **No mention needed.** In a code channel, every human message continues the task, except messages that mention other people but not the agent. Slack's origin context message is skipped.
4. **Native status and top-level replies.** The renderer sets `agents.sessions.setStatus` to `processing` when a turn starts and `active` when it ends, posts replies top-level, and keeps eve's threaded progress and task cards out of the channel.
5. **Code channel UI.** `publish_diff` reads `git diff` from the sandbox and calls `agents.conversations.setView`. `set_context_bar` and `publish_diff` call `agents.conversations.setProperties`. `archive_code_channel` calls `agents.conversations.archive` with a summary message.

## Getting started

Requires Node.js 24, pnpm, and the [Vercel CLI](https://vercel.com/docs/cli).

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

## Connect Slack and GitHub

**Slack.** Run `eve add channel/slack`. It creates or picks a Slack app through Vercel Connect, routes its events to `/eve/v1/slack`, and writes the connector UID into `agent/channels/slack.ts`. Then configure the app for Slack Code:

- Enable code channels in the app manifest:

  ```yaml
  features:
    code_channels:
      enabled: true
  ```

- Add the `code_channels:manage`, `channels:history`, and `groups:history` bot scopes.
- Subscribe to the `message.channels` and `message.groups` bot events, or to `message.session` to receive only code channel and agent session messages.

For a Connect-managed app, add the scopes and events under **Advanced** when creating the connector.

**GitHub.** Create a GitHub connector so the agent can push branches and open pull requests:

```bash
vercel connect create github --name coding-agent
```

Then set `GITHUB_ORG` (and `GITHUB_CONNECTOR` if it is not `github/coding-agent`) in `.env.local` and your Vercel project, deploy with `eve deploy`, and install the GitHub App on your repositories from the Connect dashboard.

## Limitations

This is a starting point, not a complete Slack Code integration:

- The channel-wide session is keyed on a placeholder thread, `<channelId>:0`, because eve has no channel-scoped Slack sessions yet. Approval prompts, questions to the user, and task cards are not rendered inside code channels.
- Anyone in a code channel can steer the agent. Restrict `codeChannelTurn` in `agent/channels/slack.ts` if only the requester should, and keep authorization checks in sensitive tools.
- Agent slash commands (`agents.conversations.setCommands`), canvases, and HTML views are not wired up.
- Workspaces from the Slack Code preview only know the earlier `codeChannels.*` method names. `codeChannelApi` retries with those when Slack reports `unknown_method`.

## Learn more

- [Slack Code for developers](https://docs.slack.dev/ai/slack-code)
- [Code extension](https://eve.dev/docs/code-extension)
- [Slack channel](https://eve.dev/docs/channels/slack)
