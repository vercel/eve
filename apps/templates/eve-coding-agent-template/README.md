# Coding Agent on Slack

A coding agent template for [eve](https://eve.dev). Mention it on a GitHub issue or pull request, and it investigates, reviews, or fixes code in an isolated [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), then answers in the thread or opens a pull request.

This prototype requires live membership in a configured GitHub operator team. Slack invocation is disabled until it can enforce an equivalent authorization policy.

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
  lib/github-operators.ts  live GitHub team-membership admission check
  hooks/               clears the checkout token before each GitHub turn's model call
  channels/slack.ts    invocation disabled in this prototype
  channels/github.ts   @coding-agent comments from active operator-team members
  tools/               disables write_file and agent (see below)
```

- **Tools.** The code extension adds `code__apply_patch` for edits and `code__grep` for search, next to eve's `bash` and `read_file`. The git extension adds `git__gh` for authenticated GitHub commands. `write_file` is disabled so edits go through `code__apply_patch` as small reviewable hunks.
- **Skills.** `code__investigate`, `code__review`, and `git__pr` load on demand.
- **Delegation.** `code__worker` is a read-only subagent for independent slices of a task. The root `agent` tool is disabled so all writes stay in one session.
- **Credentials.** Each `gh` command gets a token scoped to one repository, minted by [Vercel Connect](https://vercel.com/docs/connect). The sandbox only sees a placeholder. `lib/github.ts` swaps it in at the sandbox firewall for that command and removes it afterward. The GitHub channel's checkout attaches a broader token to `github.com`, so `hooks/reset-github-egress.ts` removes it before the model runs.
- **GitHub.** The triggering repository is checked out at `/workspace` before each GitHub turn, and pull request turns include the diff. Human callers must be active members of `GITHUB_OPERATOR_TEAM` within `GITHUB_ORG`. Repository collaborator status alone does not grant invocation access.

## Getting started

Requires Node.js 24, pnpm, and the [Vercel CLI](https://vercel.com/docs/cli).

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

`vercel env pull` gives the sandbox and AI Gateway their credentials. The dev UI opens a session with the agent. Without `GITHUB_ORG` the agent has no `git__gh` tool and can't open pull requests. GitHub mentions require both `GITHUB_ORG` and `GITHUB_OPERATOR_TEAM`.

## Connect Slack and GitHub

**Slack.** The channel rejects mentions, DMs, other messages, and HITL responses in this prototype. Do not remove these restrictions without a verified Slack-to-GitHub identity mapping and the same operator-team check, or an equivalent authorization policy. A Slack webhook signature alone does not grant GitHub access.

**GitHub.** Don't use `eve add channel/github` here. It stops with an error because `agent/channels/github.ts` already exists, and `--overwrite` removes its operator-team gate. Create the connector with the Vercel CLI instead:

```bash
vercel connect create github --name coding-agent --triggers \
  --trigger-event issue_comment --trigger-event pull_request_review_comment
vercel connect detach github/coding-agent --yes
vercel connect attach github/coding-agent --environment production \
  --triggers --trigger-path /eve/v1/github --yes
```

These are the commands `eve add channel/github` runs. `create` adds a default webhook destination without a path, so `detach` removes it before `attach` routes webhooks to `/eve/v1/github`.

Then set these in `.env.local` and your Vercel project:

- `GITHUB_ORG`: the GitHub organization whose repositories the agent may access. Personal-account installations do not support this team gate.
- `GITHUB_OPERATOR_TEAM`: the team slug within that organization, for example `coding-agent-operators`.
- `GITHUB_CONNECTOR`: the connector UID, if it is not `github/coding-agent`.
- `GITHUB_BOT_NAME`: your GitHub App's slug, shown on the connector in the Connect dashboard.

Give the GitHub App organization **Members: read** permission so it can query team membership. Approve the updated installation permissions if GitHub requests it. If your connector cannot obtain this permission, GitHub invocation remains disabled; this prototype has no fallback roster.

Deploy with `eve deploy`, then install the GitHub App on selected repositories from the Connect dashboard. As an active operator-team member, comment `@<bot name> <request>` on an issue or pull request within `GITHUB_ORG`.

## Operator trust boundary

Membership in `GITHUB_OPERATOR_TEAM` grants use of the App's configured repository capabilities, not just the caller's personal GitHub permissions. Use a team whose members you authorize to operate on every connector-accessible repository. GitHub's [team membership lookup](https://docs.github.com/en/rest/teams/members#get-team-membership-for-a-user) includes members of child teams. Restrict the App installation to the repositories that team should operate on.

The gate checks membership for every mentioned comment before admitting the turn, including replies to GitHub HITL prompts. Missing configuration, pending membership, API errors, and malformed responses deny invocation. Membership results are not cached. Removing a member blocks subsequent comments; it does not cancel work already admitted.

This gate does not check each target repository against the caller's personal access or authorize everyone reading the destination thread. Keep conversations and outputs within an audience authorized to see the repositories involved.

## Customize

- Change the model in `agent/agent.ts`.
- Edit `agent/instructions.md` for tone and team conventions. The extensions add their own coding guidance, so keep this file short.
- Add skills under `agent/skills/`, tools under `agent/tools/`, or override an extension contribution by name. See [Extensions](https://eve.dev/docs/extensions#override-a-contribution).
- The default HTTP channel accepts the eve TUI, Vercel OIDC, and local development. It does not use the GitHub operator-team gate. Restrict HTTP access to trusted operators, or add `agent/channels/eve.ts` to enforce your own policy. See [Auth and route protection](https://eve.dev/docs/guides/auth-and-route-protection).

## Learn more

- [Code extension](https://eve.dev/docs/code-extension)
- [Slack channel](https://eve.dev/docs/channels/slack) and [GitHub channel](https://eve.dev/docs/channels/github)
- [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel)
