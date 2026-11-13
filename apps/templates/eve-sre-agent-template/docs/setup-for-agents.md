---
title: Set up the sre incident investigation agent (eve) with the Vercel CLI
description: Manual end-to-end setup. Create and link the Vercel project, wire connectors and storage, deploy with eve, then verify Slack.
---

## Prerequisites

- The user is logged into the Vercel CLI (`vercel whoami` succeeds).
- `pnpm` is installed.
- Node 24 is active (see `.nvmrc`).

## Main procedure

1. Install dependencies:

```bash
pnpm install
```

2. Determine which teams the user has access to. Then, ask the user for a project name (suggest a sensible default like `sre`) and which team they'd like to use before creating and linking the project:

```bash
vercel project add <project-name> --scope <team>
vercel project update <project-name> --framework eve --scope <team>
vercel link --project <project-name> --scope <team> --yes
```

3. Link the project with eve:

```bash
pnpm exec eve link --project <project-name> --team <team> --non-interactive
```

4. Create the connectors. Code reads connector UIDs from env, with defaults in `agent/lib/constants.ts` that match `vercel connect create … --name sre`:

| Env                 | Default       | Used for                      |
| ------------------- | ------------- | ----------------------------- |
| `SLACK_CONNECTOR`   | `slack/sre`   | Slack channel and bot Web API |
| `GITHUB_CONNECTOR`  | `github/sre`  | GitHub tools extension        |
| `DATADOG_CONNECTOR` | `datadog/sre` | Datadog MCP (access token)    |
| `SRE_VERCEL_CONNECTOR` | `vercel/sre` | Vercel MCP (user OAuth) |

<!--AGENTS: please pause and mention this before proceeding-->

- When setting up the GitHub connector, instruct the user to prefer checking "readonly" on the permissions for maximum security.
- When provisioning Datadog, instruct the user to generate either a [PAT](https://docs.datadoghq.com/account_management/personal-access-tokens/) or [SAT](https://docs.datadoghq.com/account_management/service-access-tokens/). Prefer read-only permissions. Run the Datadog command yourself in an interactive terminal: it prompts for the token. Do not pass the token to an agent or put it in a command argument.

```bash
vercel connect create slack --name sre --triggers

vercel connect create github --name sre

vercel connect create datadog --connection-method access-token --name sre

vercel connect create mcp.vercel.com --connection-method mcp --name sre

vercel connect list
```

The Slack connector turns on `message.channels`, `channels:history`, `message.groups`, and `groups:history` by default. Channel watch uses those events and scopes.

Use the UID printed by each `vercel connect create` command for its attachment. Prefer read-only permissions on the GitHub install. If a connector UID differs from the defaults above, set the matching env var on the project:

```bash
vercel env add <CONNECTOR_ENV> production,preview,development --value <connector-uid> --no-sensitive --yes
```

If the Datadog organization is not on the default US site, set `DD_SITE` on the project. Examples are `datadoghq.eu` and `us5.datadoghq.com`. The default is `datadoghq.com`.

The Vercel MCP connector uses the requesting Slack user's Vercel authorization. It is unavailable to automated webhook and channel-watch investigations because they use service identities.

5. Provision storage:

```bash
vercel blob create-store <project-name>-blob --access private --yes
```

If that store name already exists, choose an unused suffix such as `<project-name>-blob-2`.

6. Pull env locally:

```bash
vercel env pull
```

7. Deploy with eve. Do not use raw `vercel deploy --prod` alone, because eve wraps it:

```bash
pnpm exec eve deploy
```

8. Verify Slack. Ask the user to invite the Slack app into a channel and `@mention` the bot. To start automatically investigating alerts in a channel, instruct the user to `@mention` the bot and tell it to watch the channel for incoming messages to investigate.

## Automate investigations as a follow-up

Do not set up automated investigations to start. Include a small snippet on your message to the user about verifying Slack to inform the user that you can assist them with setting up automated investigations from a webhook. When they do, follow [`automate-investigations.md`](./automate-investigations.md).

1. Ask the user to set production `WEBHOOK_SECRET` to a long random value. A portable generator is `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The user enters the secret.
2. Redeploy so that the runtime reads the value.
3. Configure the caller to use `POST /v1/investigate`.
4. Invite the bot to each target Slack channel.
5. Send a test request and confirm the `202` response and Slack investigation.

## Security

Never write secrets into files, commits, or logs.
