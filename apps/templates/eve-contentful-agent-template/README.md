# eve Contentful Agent Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Slack-based Contentful assistant built on [eve](https://eve.dev/), with Vercel Drives providing a searchable copy of your content that the agent can also query with SQL. Draft and edit entries directly in Slack, then review publication requests before the content goes live. The agent also handles asset uploads and can present results as tables or charts.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-contentful-agent-template&project-name=eve-contentful-agent&repository-name=eve-contentful-agent&env=CONTENTFUL_MANAGEMENT_TOKEN%2CCONTENTFUL_SPACE_IDS&envDescription=Contentful%20Management%20API%20token%20and%20space%20IDs%20to%20connect.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-contentful-agent-template%23getting-started&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## Getting started

Vercel's project setup flow will create a repository in your Git account and a Vercel project. You’ll create and install a Slack app via Vercel Connect, configure a private Vercel Blob store to save users’ writing preferences, and be prompted to add the following environment variables:

| Variable | Value |
| --- | --- |
| `CONTENTFUL_MANAGEMENT_TOKEN` | Your Contentful Management API token, with access to your configured spaces |
| `CONTENTFUL_SPACE_IDS` | Your Contentful space ID, or multiple IDs separated by commas |

Once you've deployed the agent, add it to a Slack channel and @mention it to start your first conversation.

## Tech stack

| Layer                        | Technology     |
| ---------------------------- | -------------- |
| Agent framework              | eve            |
| Content management           | Contentful     |
| Slack integration            | Vercel Connect |
| Content search and sync      | Vercel Sandbox |
| SQL over synced content      | DuckDB         |
| Per-user writing preferences | Vercel Blob    |

## Publishing

The agent saves edits without publishing entries. By default, publication requires approval in Slack, where a card lists the entries and assets that will go live. Any authenticated user can approve or cancel the publication request.

You can exempt supporting content types, such as authors or callouts, from approval. New asset uploads are processed and published when added to content. See [publication settings](CUSTOMIZATION.md#choose-which-content-needs-approval) for these options and their effect on linked content.

## User preferences

The agent remembers each user's writing preferences, such as tone or language, and stores them separately in private Vercel Blob storage. Preferences saved during local development are temporary.

## Local development

Use Node.js 24 with pnpm for local development. Install the [Vercel CLI](https://vercel.com/docs/cli), then clone your repository and run:

```sh
pnpm install
vercel link
vercel env pull .env.local
pnpm dev
```

Choose your deployed project when `vercel link` prompts you. `vercel env pull .env.local` saves your project's development environment variables to `.env.local`.

`pnpm dev` opens eve's interactive chat in your terminal. Type a message such as "List the content types in my space" to talk to the agent, which reads and edits content in your configured Contentful space.

Local sessions use `just-bash` without access to the content stored on Vercel Drives, so searches and SQL questions query Contentful directly. Test searches, SQL queries, and publication approval cards through the agent in Slack. See [content search on Vercel Drives](CUSTOMIZATION.md#configure-content-search-on-vercel-drives) for how the synced copy and its SQL database are built.

Before deploying, check your changes and confirm the agent builds:

```sh
pnpm validate
pnpm exec eve info
pnpm build
```

Use `pnpm fix` to apply automatic formatting and lint fixes. When the checks pass, deploy with:

```sh
vercel deploy --prod
```

## Customization

| Customize | Where |
| --- | --- |
| Your team's writing guidelines | [agent/instructions.md](agent/instructions.md) |
| Which content types need approval | `CONTENTFUL_COMPONENT_TYPES` |
| Website URL lookup | `CONTENTFUL_PUBLIC_ORIGIN` and `CONTENTFUL_PAGE_ROUTES` |
| Slack channels that receive replies without mentions | `SLACK_AUTO_REPLY_CHANNEL_IDS` |
| Model and session limits | [agent/agent.ts](agent/agent.ts) |

For more information on customizing the agent, see [CUSTOMIZATION.md](CUSTOMIZATION.md).
