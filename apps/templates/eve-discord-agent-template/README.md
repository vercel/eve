# eve Discord Agent Template

A Discord community agent built on [eve](https://eve.dev). Mention the bot with a question and it answers in a thread, catches latecomers up on what they missed, and stays quiet while people talk.

An experimental [Discord Gateway relay](https://eve.dev/docs/channels/discord/reference#reply-to-dms-and-mentions-experimental) runs as a Vercel Daemon and forwards DMs, mentions, and thread replies to the agent. Credentials go through [Vercel Connect](https://vercel.com/docs), so the bot token stays out of your environment.

The agent comes with:

- `read_recent_messages`, a custom tool that reads the channel or thread the person asked in;
- a `catch_up` skill that turns those messages into a short recap of decisions, open questions, and action items;
- `no_reply`, so the agent stays quiet when people in its thread talk to each other; and
- `web_search`, an eve default tool, for current events and facts.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-discord-agent-template&project-name=eve-discord-agent&repository-name=eve-discord-agent&connect=%5B%7B%22type%22%3A%22discord%22%2C%22env%22%3A%22DISCORD_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fdiscord%22%7D%5D)

## Getting started

Before you deploy, create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, copy the bot token and turn on **Message Content Intent**.

Vercel's project setup flow creates a repository in your Git account and a Vercel project. It asks for the bot token and creates a Discord connector through Vercel Connect, so the token stays out of your environment variables. After the first deployment:

1. Open the Discord connector in the Vercel Connect dashboard and copy its trigger URL, which looks like `https://connect.vercel.com/trigger/<connector-id>`. In the Discord Developer Portal, paste it as the **Interactions Endpoint URL** under **General Information**.
2. Add the bot to a server with `https://discord.com/oauth2/authorize?client_id=<application-id>&scope=bot%20applications.commands&permissions=309237713920`, replacing `<application-id>` with the ID on the same page.
3. Mention the bot in a channel with "what did I miss?"

The relay asks for Message Content Intent, and Discord refuses it if the intent is off. If you can't turn it on, set `messageContent: false` in `daemon/main.ts` and redeploy; people must then mention the bot in thread follow-ups.

### Set up with the CLI

Install dependencies, then run the guided Discord setup. Choose **DMs, mentions, and threads** when it asks how people should reach the agent:

```bash
pnpm install
pnpm eve add channel/discord --overwrite
```

The setup signs you in to Vercel and links a project, asks for your Discord bot token, creates a Vercel Connect connector for it, points the Discord application's Interactions Endpoint URL at the agent, and turns on the bot's Message Content intent. It then writes your connector's ID into `agent/channels/discord.ts` and `daemon/main.ts`. Setup names the connector after `package.json`'s `name`, so the ID is usually `discord/eve-discord-agent-template`, which the template already uses. If yours differs, for example because you renamed the project, put it in `agent/tools/read_recent_messages.ts` too. If Discord doesn't let setup turn on Message Content, setup sets `messageContent: false` in `daemon/main.ts`, and people must mention the bot in threads.

Deploy to production to start the relay:

```bash
pnpm eve deploy
```

Open the bot install URL that setup printed, add the bot to a server, and mention it in a channel with "what did I miss?"

## Local development

Pull a development OIDC token, then start the agent:

```bash
vercel env pull .env.local
pnpm dev
```

To send Discord messages to your local agent instead of production, scale the production daemon to zero, then run the relay against `eve dev` from another terminal. Every relay receives every message, so two relays make the agent answer twice.

```bash
EVE_URL=http://localhost:2000 node --env-file=.env.local daemon/main.ts
```

Edit the agent's behavior in `agent/instructions.md`, its tools in `agent/tools/`, and its skills in `agent/skills/`. The agent auto-updates as you edit the files.

## Learn more

This project uses the eve framework's bundled guides. After installing dependencies, see `node_modules/eve/docs/`.

- [eve documentation](https://eve.dev/docs) - learn about eve features and API.
- [Discord channel](https://eve.dev/docs/channels/discord) - the channel, the Gateway relay, and their options.
- [Vercel Connect](https://vercel.com/docs) - manages the Discord channel's credentials in this template.

You can check out [the eve GitHub repository](https://github.com/vercel/eve) - your feedback and contributions are welcome!
