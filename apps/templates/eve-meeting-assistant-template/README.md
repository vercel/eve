# eve Meeting Assistant

An [eve](https://eve.dev) agent that joins Zoom, Google Meet, and Microsoft Teams calls through a [Recall.ai](https://recall.ai) bot, answers out loud, and keeps Linear in sync with the conversation. Say "eve, open a Linear ticket for this and assign Bob", and it says it's on it, opens the issue, and puts the link in the meeting chat. Ask in the chat, and it answers in the chat.

Set `MEETING_VOICE=off` to have it answer only in the meeting chat. The bot's camera still shows when it's listening and thinking.

## Architecture

```text
meeting speech + chat → Recall webhooks → recallChannel → eve session → Linear MCP
                                                              │ streamed reply
bot camera + mic ← Output Media page ← speech + status ← GET /eve/v1/recall/voice/stream
                                                              │
                                                              └─ meeting chat
```

Recall joins the call, transcribes it, and posts each final utterance and chat message to eve's [Recall.ai channel](https://eve.dev/docs/channels/recall). Each bot gets one durable session, so "update that ticket" can refer to an issue opened earlier in the call. Every chat message starts a turn. For speech, a fast [`decide`](https://eve.dev/docs/guides/decide) call judges whether the line is asking eve for something, which holds up better than name matching when transcription mangles "eve". Everything else is kept as recent transcript, so quiet stretches of the meeting cost only decision calls, not agent turns.

The bot shows a page from the agent as its camera, using Recall's [Output Media](https://docs.recall.ai/docs/stream-media). The page holds one request open to `/eve/v1/recall/voice/stream`, which follows the meeting's session. It draws a dot-matrix waveform that follows whoever is talking and shows when eve is thinking.

With voice on, the same route cuts the model's streamed reply into sentences and synthesizes each through [AI Gateway](https://vercel.com/docs/ai-gateway) speech models, so the first sentence plays while the model is still writing the rest. The agent starts each message with `[voice]`, `[chat]`, or `[both]`: it answers out loud when asked out loud, in the chat when asked in the chat, and switches to the chat when someone asks it to stay quiet or people are talking with each other. When someone talks over eve, the page stops playback and drops the rest of that reply.

The main pieces are:

- `agent/channels/recall.ts`: `recallChannel()` from `@eve/recall`, with the page routes, the `shouldRespond` check for which lines get an answer, and which replies go to the chat
- `agent/lib/voice.ts`: the bot config with Output Media, the page and stream routes, sentence splitting, and speech synthesis
- `agent/lib/voice-page.ts`: the page the bot streams
- `agent/lib/voice-mode.ts`: the `MEETING_VOICE` toggle
- `agent/tools/join_meeting.ts`: sends a bot to a meeting on request, for testing
- `agent/connections/linear.ts`: [Linear's MCP server](https://linear.app/docs/mcp) through an app-scoped [Vercel Connect](https://vercel.com/docs/connect) connector
- `agent/instructions.md` and `agent/instructions/replies.ts`: when to speak, how to work with Linear, and how to reply in each mode

Recall creates the bot id, so the page URL can't carry it. Instead, the page URL and the bot's metadata share a random key. The stream route looks the bot up in Recall by that key, then finds its session, so a page URL only ever reads its own meeting.

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
RECALL_WEBHOOK_URL=https://...     # for local development or a protected deployment
MEETING_VOICE=off                  # optional; answer in the meeting chat only
VOICE_SPEECH_MODEL=openai/tts-1    # optional; any AI Gateway speech model
VOICE_SPEECH_VOICE=alloy           # optional; a voice the speech model offers
```

The agent's instructions are built at build time, so redeploy after changing `MEETING_VOICE`.

## Deploy

```bash
vercel deploy --prod
```

Recall posts to `/eve/v1/recall` at the production URL, and the bot loads its page from `/eve/v1/recall/voice` on the same host, with the same query. eve never adds a Deployment Protection bypass to those URLs, so if protection covers production, Recall can't reach them until you give it a way in. One option is to run `vercel project protection enable --protection-bypass`, set `RECALL_WEBHOOK_URL` to `https://<production-host>/eve/v1/recall?x-vercel-protection-bypass=<secret>`, and redeploy. Add the same query to webhook URLs you configure in Recall yourself.

## Join meetings

Use Recall's [calendar integration](https://docs.recall.ai/docs/calendar-integration) so the bot joins meetings automatically, such as every meeting its calendar is invited to. Configure those bots with the body `meetingBotConfig` from `agent/lib/voice.ts` builds, as `agent/tools/join_meeting.ts` does, with `webhookUrl` set to `https://<your-project>.vercel.app/eve/v1/recall`. Previews send their own bots' webhooks to themselves.

To test without a calendar, open the terminal UI against the deployment and ask the agent to join a meeting, then admit the bot:

```bash
pnpm exec eve remote connect --url https://<your-project>.vercel.app
# > Join https://meet.google.com/abc-defg-hij
```

To debug the bot's page while it's in a call, open the bot in Recall's Bot Explorer and click **Open Remote Devtools**.

## Run locally

```bash
pnpm install
pnpm dev
```

Expose the dev server with an HTTPS tunnel and set `RECALL_WEBHOOK_URL` to `https://<your-tunnel>/eve/v1/recall`.

## Limits

- Each participant is their own principal, `recall:<botId>:<participantId>`, but display names prove nothing. Anyone in the meeting can use the Linear connector's access, so scope its Linear user accordingly.
- Every final utterance makes one decision-model call. If it fails or takes over three seconds, the channel falls back to answering speech that names "eve".
- A spoken reply takes a few seconds: transcription, the `decide` check, the model's first sentence, and speech synthesis.
- Talking over eve is detected by loudness, so background noise can cut it off. An interrupted reply stays whole in the session's history.
- Approvals, questions, and sign-ins go to the meeting chat as text.
- The bot runs Recall's `web_4_core` variant so the page animates and plays audio smoothly, which Recall bills at a higher rate.
