This is a Discord community agent template for [eve](https://eve.dev). Mention the bot with a question and it answers in a thread, catches latecomers up on what they missed, and stays quiet while people talk.

An experimental [Discord Gateway relay](https://eve.dev/docs/channels/discord#reply-to-dms-and-mentions-experimental) runs as a Vercel Daemon and forwards DMs, mentions, and thread replies to the agent. Credentials go through [Vercel Connect](https://vercel.com/docs), so the bot token stays out of your environment.

The agent comes with:

- `read_recent_messages`, a custom tool that reads the channel or thread the person asked in;
- a `catch_up` skill that turns those messages into a short recap of decisions, open questions, and action items;
- `no_reply`, so the agent stays quiet when people in its thread talk to each other; and
- `web_search`, an eve default tool, for current events and facts.

## Get started

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

## Develop locally

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

This project uses the eve framework's bundled guides. After installing dependencies, see `node_modules/eve/dist/docs/public/`.

- [eve documentation](https://eve.dev/docs) - learn about eve features and API.
- [Discord channel](https://eve.dev/docs/channels/discord) - the channel, the Gateway relay, and their options.
- [Vercel Connect](https://vercel.com/docs) - manages the Discord channel's credentials in this template.

You can check out [the eve GitHub repository](https://github.com/vercel/eve) - your feedback and contributions are welcome!
