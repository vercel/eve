# eve Memory Agent Template

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack) [![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

Slack-based assistant built on [eve](https://eve.dev/) that saves the preferences people share with it. Personal preferences and shared channel conventions are saved separately and recalled at the start of every conversation.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Feve-memory-agent-template&project-name=eve-memory-agent&repository-name=eve-memory-agent&connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## Getting started

Vercel's project setup flow creates a repository in your Git account and a Vercel project. You'll create and install a Slack app via Vercel Connect and configure a private Vercel Blob store to save user and channel preferences.

Once you've deployed the agent, add it to a Slack channel and @mention it to start your first conversation.

## Tech stack

| Layer             | Technology     |
| ----------------- | -------------- |
| Agent framework   | eve            |
| Slack integration | Vercel Connect |
| Memory storage    | Vercel Blob    |
| Sandbox           | Vercel Sandbox |

## How memory works

The agent has two memories, each defined as a file in [agent/memory/](agent/memory/):

| Memory | File | Shared by |
| --- | --- | --- |
| User preferences | [user-preferences.ts](agent/memory/user-preferences.ts) | One Slack user, across every channel and DM |
| Channel preferences | [channel-preferences.ts](agent/memory/channel-preferences.ts) | Everyone in one Slack channel |

Before the agent responds to each message, eve recalls both memories, and the model saves or removes entries with each memory's own tools. [agent/instructions.md](agent/instructions.md) tells it to use channel memory only when someone states a preference for the whole channel, and to follow a user's own preference over the channel's.

Memory is tied to the verified Slack user and channel, never to anything the model or user writes. DMs have no shared channel, so they only use user memory.

On Vercel, memory is stored in the connected private Blob store. During local development with `pnpm dev`, memory lasts only while the development server runs and is cleared each time you restart it.

## Slack identity

Before responding to each message, the agent looks up the Slack profile of everyone involved in the thread, including people who are mentioned. It adds their names and profile images to the conversation as context, but never email addresses.

To skip profile lookups for selected bot or service accounts, set the `SLACK_IDENTITY_EXCLUDED_USER_IDS` environment variable to a comma-separated list of their Slack user IDs:

```dotenv
SLACK_IDENTITY_EXCLUDED_USER_IDS=U0123456789,U0987654321
```

## Local development

Use Node.js 24 with pnpm. Install the [Vercel CLI](https://vercel.com/docs/cli), then clone your repository and run:

```sh
pnpm install
vercel link
vercel env pull .env.local
pnpm dev
```

Choose your deployed project when `vercel link` prompts you. `vercel env pull .env.local` saves your project's development environment variables to `.env.local`.

`pnpm dev` opens eve's interactive chat in your terminal. Type a message such as "Remember that I prefer short answers" to talk to the agent, then type `/new` to start a new conversation and check that it follows the preference. Locally, every conversation shares one user memory and one channel memory.

Local sessions use `just-bash` instead of Vercel Sandbox, and don't look up Slack profiles. Test Slack identity and separate memories for different users and channels through the agent in Slack.

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
| What the agent remembers about users | `description` in [agent/memory/user-preferences.ts](agent/memory/user-preferences.ts) |
| What the agent remembers about channels | `description` in [agent/memory/channel-preferences.ts](agent/memory/channel-preferences.ts) |
| Who shares a memory | `scope` in each memory file |
| When to save, and response style | [agent/instructions.md](agent/instructions.md) |
| Model and session limits | [agent/agent.ts](agent/agent.ts) |

For more ways to customize the agent, including how to build your own memory provider, see [CUSTOMIZATION.md](CUSTOMIZATION.md).

## Extend your agent with Vercel Drives

Memory suits short preferences the agent saves during conversations. To give it longer documents your team maintains, such as runbooks or a glossary of internal terms, store them on a [Vercel Drive](https://vercel.com/kb/guide/vercel-drives) and mount it into the agent's sandbox. The agent searches the files when a question calls for them but can't change them, so you stay in control of what they say.

See [Give the agent shared reference files](CUSTOMIZATION.md#give-the-agent-shared-reference-files) for setup steps.
