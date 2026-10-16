# Meeting Agent

An [eve](https://eve.dev) agent that joins Zoom, Google Meet, and Microsoft Teams calls through a [Recall.ai](https://recall.ai) bot and keeps Linear in sync with the conversation. Ask "eve, open a Linear ticket for this and assign Bob", and it replies in the meeting chat with the issue link.

## Architecture

```text
Recall bot → transcript + chat webhooks → eve session → Linear MCP → meeting chat
```

Recall joins the call, transcribes it, and posts each final utterance, chat message, and join to a custom [channel](https://eve.dev/docs/channels/custom). Each bot gets one durable session, so "update that ticket" can refer to an issue opened earlier in the call. The agent hears everything and calls `no_reply` unless someone addresses it. On the first join it loads Linear's tools, teams, and users, so a first request is usually one `linear__save_issue` call.

The main pieces are:

- `agent/channels/recall.ts`: verifies Recall webhooks and posts replies to the meeting chat
- `agent/lib/recall.ts`: the bot config Recall needs, and webhook parsing
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

Recall posts to `/recall/webhook` at the production URL. If Deployment Protection covers production, run `vercel project protection enable --protection-bypass`, redeploy, and append `?x-vercel-protection-bypass=<secret>` to webhook URLs you configure in Recall.

## Join meetings

Use Recall's [calendar integration](https://docs.recall.ai/docs/calendar-integration) so the bot joins meetings automatically, such as every meeting its calendar is invited to. Configure those bots like `createBot` in `agent/lib/recall.ts`: name the bot `eve`, use `recallai_streaming` transcription, and add a real-time webhook endpoint at `https://<your-project>.vercel.app/recall/webhook/` for `transcript.data`, `participant_events.chat_message`, and `participant_events.join`.

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

Expose the dev server with an HTTPS tunnel and set `RECALL_WEBHOOK_URL` to `https://<your-tunnel>/recall/webhook`.

## Limits

- Everyone in the call shares one principal, `recall:bot:<id>`, because speaker names prove nothing. Anyone in the meeting can use the Linear connector's access, so scope its Linear user accordingly.
- Every utterance is a model call. The `queue` turn policy batches utterances that arrive during a turn, but long meetings still make many calls.
- Replies are chat text, split to fit Google Meet's 500-character limit.
