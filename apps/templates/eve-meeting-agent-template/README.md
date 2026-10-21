# Meeting Agent

An [eve](https://eve.dev) agent that joins Zoom, Google Meet, and Microsoft Teams calls through a [Recall.ai](https://recall.ai) bot and keeps Linear in sync with the conversation. Ask "eve, open a Linear ticket for this and assign Bob", and it replies in the meeting chat with the issue link.

## Architecture

```text
Recall bot → transcript + chat webhooks → eve session → Linear MCP → meeting chat
```

Recall joins the call, transcribes it, and posts each final utterance and chat message to eve's [Recall.ai channel](https://eve.dev/docs/channels/recall). Each bot gets one durable session, so "update that ticket" can refer to an issue opened earlier in the call. Every chat message starts a turn. For speech, a fast [`decide`](https://eve.dev/docs/guides/decide) call judges whether the line is asking eve for something, which holds up better than name matching when transcription mangles "eve". Everything else is kept as recent transcript, so quiet stretches of the meeting cost only decision calls, not agent turns.

The main pieces are:

- `agent/channels/recall.ts`: `recallChannel()` from `eve/channels/recall`, which verifies Recall webhooks and posts replies to the meeting chat, plus the `shouldRespond` check for which lines get an answer
- `agent/tools/join_meeting.ts`: sends a bot to a meeting on request, for testing
- `agent/connections/linear.ts`: [Linear's MCP server](https://linear.app/docs/mcp) through an app-scoped [Vercel Connect](https://vercel.com/docs/connect) connector
- `agent/instructions.md`: when to speak and how to work with Linear

## Set up

You need a [Recall.ai](https://www.recall.ai) API key and [workspace verification secret](https://docs.recall.ai/docs/authenticating-requests-from-recallai), and a [Linear API key](https://linear.app/settings/api). Link a Vercel project, then create and attach the Linear connector:

```bash
vercel link
read -rs LINEAR_API_KEY   # paste your lin_api_... key
printf '[{"value":"%s"}]' "$LINEAR_API_KEY" |
  vercel connect create linear --connection-method api-key --name linear --data @-
vercel connect attach <connector-uid>
```

Reading the key from stdin keeps it out of your shell history and off disk, so it can't be deployed or committed. Then set:

```bash
LINEAR_CONNECTOR=<connector-uid>   # defaults to "linear"
RECALL_API_KEY=...
RECALL_WORKSPACE_VERIFICATION_SECRET=whsec_...
RECALL_REGION=us-east-1            # your Recall workspace region
RECALL_WEBHOOK_URL=https://...     # only needed for local development
```

## Deploy

```bash
vercel deploy --prod
```

Recall posts to `/eve/v1/recall` at the production URL. If Deployment Protection covers production, run `vercel project protection enable --protection-bypass`, and redeploy. Bots the agent creates carry the bypass secret automatically; append `?x-vercel-protection-bypass=<secret>` to webhook URLs you configure in Recall yourself.

## Join meetings

Use Recall's [calendar integration](https://docs.recall.ai/docs/calendar-integration) so the bot joins meetings automatically, such as every meeting its calendar is invited to. Configure those bots with the body `recallBotConfig` from `eve/channels/recall` builds, as `agent/tools/join_meeting.ts` does, with `webhookUrl` set to `https://<your-project>.vercel.app/eve/v1/recall`. Previews send their own bots' webhooks to themselves.

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
- Every final utterance makes one decision-model call. If it fails or takes over five seconds, the channel falls back to answering speech that names "eve".
- Replies are chat text, split to fit each platform's chat limit.
