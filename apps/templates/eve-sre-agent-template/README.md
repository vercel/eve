[deploy-with-vercel]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-sre-agent-template%2Ftree%2Fmain&project-name=sre&repository-name=sre&from=templates&products=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%2C%7B%22type%22%3A%22github%22%2C%22env%22%3A%22GITHUB_CONNECTOR%22%7D%2C%7B%22type%22%3A%22datadog%22%2C%22env%22%3A%22DATADOG_CONNECTOR%22%7D%2C%7B%22type%22%3A%22vercel%22%2C%22env%22%3A%22SRE_VERCEL_CONNECTOR%22%7D%5D

![sre banner](./.github/banner.png)

# sre

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

sre is an [eve](https://eve.dev) incident response agent for Slack. It brings together the observability data you need to debug an alert or incident across Datadog, GitHub, Vercel, and other tools. Investigations are read-only by default.

Mention `@sre`, watch a channel for alerts, or invoke it from an external system with a webhook. The agent checks hypotheses against live signals and records each finding with a source link. Replies start with the answer, then the supporting evidence.

[![Deploy with Vercel](https://vercel.com/button)][deploy-with-vercel]

## How it works

An investigation starts from one of three places.

- A Slack mention or direct message.
- A new top-level message in a watched Slack channel.
- A `POST /v1/investigate` webhook call.

The agent records novel, decision-relevant findings with source links. Each investigation turn has its own evidence set. The agent records each finding-and-URL pair once, then adds recorded evidence to the Slack result.

Automated runs use webhook metadata and service-authenticated tools. They do not use per-user OAuth.

Channel watch and custom skills are optional. Both store state in Vercel Blob. The Blob store is required only for these two features.

## Set up the project

Select [**Deploy with Vercel**][deploy-with-vercel] to clone the repository, create a Vercel project, and provision the connectors and storage.

| Provisioned                                       | Sets                                |
| ------------------------------------------------- | ----------------------------------- |
| Slack connector with trigger path `/eve/v1/slack` | `SLACK_CONNECTOR`                   |
| GitHub connector, read-only install               | `GITHUB_CONNECTOR`                  |
| Datadog connector                                 | `DATADOG_CONNECTOR`                 |
| Vercel MCP connector                              | `SRE_VERCEL_CONNECTOR`              |
| Private Vercel Blob store                         | Vercel Blob environment variables   |

For a complete CLI setup with your agent, use [`docs/setup-for-agents.md`](./docs/setup-for-agents.md).

After deployment:

1. Invite the Slack app to a channel.
2. Mention `@sre` and confirm that the app replies.
3. To enable automated runs via a webhook, follow [`docs/automate-investigations.md`](./docs/automate-investigations.md).

## Local development

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

## Environment configuration

| Variable            | Required          | Default         | What it does                                                                                            |
| ------------------- | ----------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `SLACK_CONNECTOR`   | No                | `slack/sre`     | Connector UID for the Slack channel and bot Web API.                                                    |
| `GITHUB_CONNECTOR`  | No                | `github/sre`    | Connector UID for the GitHub tools extension.                                                           |
| `DATADOG_CONNECTOR` | No                | `datadog/sre`   | Connector UID for the Datadog MCP tools.                                                                |
| `SRE_VERCEL_CONNECTOR` | No             | `vercel/sre`     | Connector UID for the Vercel MCP tools.                                                                |
| `WEBHOOK_SECRET`    | No | none            | Shared secret for `POST /v1/investigate`. Use a long random value from Node crypto (`randomBytes(32)`). |
| `DD_SITE`           | No                | `datadoghq.com` | Datadog site for MCP. Examples are `datadoghq.eu` and `us5.datadoghq.com`.                              |

Copy [`.env.example`](./.env.example) to `.env` to set local environment variables.

## Automation endpoint

`POST /v1/investigate` accepts a title, a Slack channel, an optional description, and optional metadata. It returns `202` and starts a Slack investigation.

The endpoint uses `WEBHOOK_SECRET`. Send the secret with `x-sre-webhook-secret` or `Authorization: Bearer`.

## Customize the agent

- Edit `agent/instructions/instructions.md` to change general behavior.
- Edit the built-in skills in `agent/skills/` to change investigation and handoff procedures.
- Add tools or connections for other operational systems using Vercel Connect.
- Integrate with `agent/channels/webhook.ts` to invoke the agent from any external system (see [`docs/automate-investigations.md`](./docs/automate-investigations.md)).

### Create runbooks in Slack

Ask `@sre` to create a runbook for a recurring alert or incident. Global runbooks apply to every session. Personal runbooks apply only to the requesting Slack user and override global runbooks with the same name. The agent loads a saved runbook on a later matching request, not during the request that creates it. Private Vercel Blob storage is required to save and load runbooks. Stored names can contain up to 64 characters. Names longer than 57 characters receive a shortened, hash-suffixed load name so they fit eve's runtime limit; the stored name used to list or delete the runbook stays unchanged.

## Verify changes

```bash
pnpm validate
pnpm test
```

## Troubleshooting

- If Slack mentions do not arrive, confirm that the trigger path is `/eve/v1/slack`.
- If a webhook returns `401`, confirm that the caller and the deployment use the same `WEBHOOK_SECRET`.
- If an investigation does not start, confirm that the bot is a member of `slackChannel`.
- If custom skills fail to save, confirm that the private Blob store is connected.
- If Vercel tools request authorization, complete the Vercel Connect sign-in for the Slack user. Automated runs do not have a user identity, so they cannot use this connection.

## Learn more

- [eve documentation](https://eve.dev/docs/introduction)
- [Automate investigations with generic webhooks](./docs/automate-investigations.md)
- [Vercel Connect](https://vercel.com/docs/connect)
- [Vercel Blob](https://vercel.com/docs/vercel-blob)

## Explore more templates

- [eve software factory](https://vercel.com/templates/eve/eve-software-factory)
- [eve marketing team](https://vercel.com/templates/eve/eve-marketing-team)
- [eve personal agent](https://vercel.com/templates/nuxt/eve-personal-agent)
- [All eve templates](https://vercel.com/templates/eve)
