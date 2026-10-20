# Meeting Agent

An [eve](https://eve.dev) agent that joins Zoom, Google Meet, and Microsoft Teams calls through a [Recall.ai](https://recall.ai) bot and keeps Linear in sync with the conversation. Ask "eve, open a Linear ticket for this and assign Bob", and it replies in the meeting chat with the issue link.

## Architecture

```text
Recall bot → transcript + chat webhooks → eve session → Linear MCP → meeting chat
```

Recall joins the call, transcribes it, and posts each final utterance and chat message to eve's [Recall.ai channel](https://eve.dev/docs/channels/recall). Each bot gets one durable session, so "update that ticket" can refer to an issue opened earlier in the call. Only chat messages and speech that says "eve" start a turn; everything else is kept as recent transcript, so quiet stretches of the meeting cost no model calls.

The main pieces are:

- `agent/channels/recall.ts`: `recallChannel()` from `eve/channels/recall`, which verifies Recall webhooks, decides which lines get an answer, and posts replies to the meeting chat
- `agent/lib/webhook-url.ts`: the public webhook URL bots post to
- `agent/tools/join_meeting.ts`: sends a bot to a meeting on request, for testing
- `agent/connections/linear.ts`: [Linear's MCP server](https://linear.app/docs/mcp) through an app-scoped [Vercel Connect](https://vercel.com/docs/connect) connector
- `agent/instructions.md`: when to speak and how to work with Linear

## Set up

You need a [Recall.ai](https://www.recall.ai) API key and [workspace verification secret](https://docs.recall.ai/docs/authenticating-requests-from-recallai), and a [Linear API key](https://linear.app/settings/api). Link a Vercel project, then create and attach the Linear connector:

```bash
vercel link
vercel connect create linear --connection-method api-key --name linear --data @linear-key.json
vercel connect attach <connector-uid>
```

`linear-key.json` holds `[{ "value": "lin_api_..." }]`. Then set:

```bash
LINEAR_CONNECTOR=<connector-uid>   # defaults to "linear"
RECALL_API_KEY=...
RECALL_WORKSPACE_VERIFICATION_SECRET=whsec_...
RECALL_REGION=us-east-1            # your Recall workspace region
RECALL_WEBHOOK_URL=https://...     # only needed for previews or local development
```

## Deploy

```bash
vercel deploy --prod
```

Recall posts to `/eve/v1/recall` at the production URL. If Deployment Protection covers production, run `vercel project protection enable --protection-bypass`, redeploy, and append `?x-vercel-protection-bypass=<secret>` to webhook URLs you configure in Recall.

## Join meetings

Use Recall's [calendar integration](https://docs.recall.ai/docs/calendar-integration) so the bot joins meetings automatically, such as every meeting its calendar is invited to. Configure those bots with the body `recallBotConfig` from `eve/channels/recall` builds, as `agent/tools/join_meeting.ts` does, with `webhookUrl` set to `https://<your-project>.vercel.app/eve/v1/recall`.

To test without a calendar, open the terminal UI against the deployment and ask the agent to join a meeting, then admit the bot:

```bash
pnpm exec eve remote connect --url https://<your-project>.vercel.app
# > Join https://meet.google.com/abc-defg-hij
```

## Run locally

```bash
pnpm install
pnpm dev
```

Expose the dev server with an HTTPS tunnel and set `RECALL_WEBHOOK_URL` to `https://<your-tunnel>/eve/v1/recall`.

## Limits

- Each participant is their own principal, `recall:<botId>:<participantId>`, but display names prove nothing. Anyone in the meeting can use the Linear connector's access, so scope its Linear user accordingly.
- Speech that mentions "eve" in passing still starts a turn; the agent calls `no_reply` when it isn't a request.
- Replies are chat text, split to fit each platform's chat limit.
