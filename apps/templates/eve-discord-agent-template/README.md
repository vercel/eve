This is a conversational Discord agent template for [eve](https://eve.dev), set up as a helper for a casual professional community.

People talk to the agent in DMs, by mentioning it in a channel, or by replying in the thread it starts. An experimental [Discord Gateway relay](https://eve.dev/docs/channels/discord#reply-to-dms-and-mentions-experimental) runs as a Vercel Daemon and forwards those messages to the agent, which replies through Discord's API. Credentials go through [Vercel Connect](https://vercel.com/docs), so the bot token stays out of your environment.

The agent comes with:

- `web_search`, an eve default tool, for current events and facts;
- `ask_question`, which shows two or three choices as Discord buttons;
- `no_reply`, so the agent stays quiet when people in its thread talk to each other;
- `convert_time`, an example custom tool that converts event times between time zones and returns a Discord timestamp, which shows the time in each reader's own time zone;
- a `plan_an_event` skill for picking a time and drafting an announcement;
- a `welcome_new_members` skill for onboarding, with community norms to edit in `agent/skills/welcome_new_members.md`; and
- per-user long-term memory, keyed to each person's Discord account.

## Getting Started

First, install dependencies:

```bash
pnpm install
```

Then run the guided Discord setup, and choose **DMs, mentions, and threads** when it asks how people should reach the agent:

```bash
pnpm eve add channel/discord --overwrite
```

The setup signs you in to Vercel and links a project, asks for your Discord bot token, creates a Vercel Connect connector for it, points the Discord application's Interactions Endpoint URL at the agent, and turns on the bot's Message Content intent. It then rewrites `agent/channels/discord.ts` and `daemon/main.ts` with your connector's ID; `--overwrite` lets it replace the placeholder `discord/my-agent` this template ships with. If Discord doesn't let setup turn on Message Content, setup sets `messageContent: false` in `daemon/main.ts`, and people must mention the bot in threads.

Deploy to production to start the relay:

```bash
pnpm eve deploy
```

Open the bot install URL that setup printed, add the bot to a server, and mention it in a channel or send it a DM.

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

You can start editing the agent by modifying `agent/agent.ts`. Its behavior is defined in `agent/instructions.md`, tools live in `agent/tools/`, and skills live in `agent/skills/`. The agent auto-updates as you edit the files.

## Memory

`agent/memory/profile.ts` gives the agent a small document of durable facts and preferences for each Discord user. In local development eve keeps memory in process, and it resets when the dev server restarts. On Vercel, the agent has no memory tools until a private Blob store is connected:

```bash
pnpm exec eve integration setup file-memory --yes
```

The command creates or reuses a private Vercel Blob store, connects it to the project, and pulls the `EVE_MEMORY_BLOB_*` environment variables into `.env.local`. Blob usage may incur charges. Redeploy after running it.

## Learn More

This project uses the eve framework's bundled guides — see `node_modules/eve/dist/docs/public/` after installing dependencies.

To learn more about eve, take a look at the following resources:

- [eve documentation](https://eve.dev/docs) - learn about eve features and API.
- [Discord channel](https://eve.dev/docs/channels/discord) - the channel, the Gateway relay, and their options.
- [Vercel Connect](https://vercel.com/docs) - manages the Discord channel's credentials in this template.

You can check out [the eve GitHub repository](https://github.com/vercel/eve) - your feedback and contributions are welcome!
