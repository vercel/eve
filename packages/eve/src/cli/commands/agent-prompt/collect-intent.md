## Collect intent

If the user's intent is not already clear, ask the questions one at a time, use
the coding harness's prompt tools when available, and do not guess.

1. What should the agent do? This becomes its always-on purpose.
2. Where should it be reachable? Every agent ships the built-in HTTP channel. On
   top of that:
   - **Web Chat** (a Next.js app): add it at init with `--channel-web-nextjs`.
   - **Slack** and other platforms: add after deploy with `eve channels add slack`.
     Credentials run through **Vercel Connect**, which provisions the bot token
     and verifies inbound webhooks, so there is no `SLACK_BOT_TOKEN` or signing
     secret to manage.
3. Which external systems does it need programmatic read/write access to, such as
   Slack, Salesforce, Linear, GitHub, or your own API? Each becomes a connection
   under `agent/connections/`. When a system needs every end-user to sign in, wire
   its auth through **Vercel Connect** (`connect()` from `@vercel/connect/eve`),
   which handles consent, encrypted token storage, and refresh.
