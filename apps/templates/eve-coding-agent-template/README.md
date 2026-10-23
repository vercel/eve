# Coding Agent on Slack

A coding agent template for [eve](https://eve.dev). Mention it in Slack, or on a GitHub issue or pull request, and it investigates, reviews, or fixes code in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), then answers in the thread or opens a pull request.

## How it works

The coding capabilities come from eve's built-in [code extension](https://eve.dev/docs/code-extension), and GitHub access comes from its companion git extension. This template wires them to Slack and GitHub and keeps everything else default.

```txt
agent/
  agent.ts             model, reasoning, compaction
  instructions.md      identity and delivery rules
  sandbox.ts           Vercel Sandbox with gh, git, and TypeScript tooling
  extensions/code.ts   mounts eve/extensions/code
  extensions/git.ts    mounts eve/extensions/git with Connect-brokered GitHub access
  lib/github.ts        Connect connector and the firewall credential broker
  hooks/               clears the checkout token before each GitHub turn's model call
  channels/slack.ts    @mentions in Slack
  channels/github.ts   @coding-agent comments from trusted repository members
  tools/               disables write_file and agent (see below)
```

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

`vercel env pull` gives the sandbox and AI Gateway their credentials. The dev UI opens a session with the agent. Until you list organizations in `agent/extensions/git.ts`, the agent has no `git__gh` tool and can't open pull requests. The GitHub channel still answers mentions.

## Connect Slack and GitHub

**Slack.** Run `eve add channel/slack`. It creates or picks a Slack app through Vercel Connect, routes its events to `/eve/v1/slack`, and writes the connector UID into `agent/channels/slack.ts`.

**GitHub.** Don't use `eve add channel/github` here. It stops with an error because `agent/channels/github.ts` already exists, and `--overwrite` replaces the file along with its rule that only repository owners, members, and collaborators can start a turn. Create the connector with the Vercel CLI instead:

```bash
vercel connect create github --name coding-agent --triggers \
  --trigger-event issue_comment --trigger-event pull_request_review_comment
vercel connect detach github/coding-agent --yes
vercel connect attach github/coding-agent --environment production \
  --triggers --trigger-path /eve/v1/github --yes
```

These are the commands `eve add channel/github` runs. `create` adds a default webhook destination without a path, so `detach` removes it before `attach` routes webhooks to `/eve/v1/github`.

Then list the organizations or users whose repositories the agent may access in `orgs` in `agent/extensions/git.ts`, and set these in `.env.local` and your Vercel project:

- `GITHUB_CONNECTOR`: the connector UID, if it is not `github/coding-agent`
- `GITHUB_BOT_NAME`: your GitHub App's slug, shown on the connector in the Connect dashboard

Deploy with `eve deploy`, then install the GitHub App on your repositories from the Connect dashboard. Mention the app in Slack, or comment `@<bot name> <request>` on an issue or pull request. Delete `agent/channels/github.ts` if you only want Slack; the agent still needs the GitHub connector and `orgs` to open pull requests.

## Customize

- Change the model in `agent/agent.ts`.
- Edit `agent/instructions.md` for tone and team conventions. The extensions add their own coding guidance, so keep this file short.
- Add skills under `agent/skills/`, tools under `agent/tools/`, or override an extension contribution by name. See [Extensions](https://eve.dev/docs/extensions#override-a-contribution).
- The default HTTP channel accepts the eve TUI, Vercel OIDC, and local development. Add `agent/channels/eve.ts` to put your own auth in front of it. See [Auth and route protection](https://eve.dev/docs/guides/auth-and-route-protection).

## Learn more

- [Code extension](https://eve.dev/docs/code-extension)
- [Slack channel](https://eve.dev/docs/channels/slack) and [GitHub channel](https://eve.dev/docs/channels/github)
- [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel)
