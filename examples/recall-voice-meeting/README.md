# Voice meeting agent

An eve agent that joins Zoom, Google Meet, and Microsoft Teams calls through a [Recall.ai](https://recall.ai) bot and answers out loud. Say "eve, what did Bob say about the launch date?", and the bot replies by voice. If someone talks over it, it stops talking.

It's the [Recall.ai channel](https://eve.dev/docs/channels/recall) with one change: replies are spoken through Recall's [Output Media](https://docs.recall.ai/docs/stream-media) instead of posted to the meeting chat.

## How it works

```text
meeting speech → Recall transcript webhook → recallChannel → eve session
                                                                 │ streamed reply text
bot camera + mic ← Output Media page ← MP3 per sentence ← GET /eve/v1/recall/voice/stream
```

The meeting side is unchanged: Recall transcribes the call and posts each final utterance to the channel, and a fast [`decide`](https://eve.dev/docs/guides/decide) call in `shouldRespond` picks the lines meant for eve.

For the reply, the bot loads a page from the agent as its camera and microphone. The page holds one request open to `/eve/v1/recall/voice/stream`, which follows the meeting's eve session. As the model streams its reply, the route cuts it into sentences and synthesizes each through [AI Gateway](https://vercel.com/docs/ai-gateway) speech models, so the first sentence plays while the model is still writing the rest. Text the agent writes before a tool call, such as "Sure, let me check.", is spoken too, so nobody waits in silence.

The page also hears the meeting's mixed audio, without the bot's own voice. When someone talks for more than about a third of a second while eve is speaking, the page stops playback and drops the rest of that reply.

| File                          | Role                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `agent/channels/recall.ts`    | `recallChannel()` with the voice routes, the `shouldRespond` check, and chat only for replies with a link |
| `agent/lib/voice.ts`          | The bot config with Output Media, the page and stream routes, sentence splitting, and speech synthesis    |
| `agent/lib/voice-page.ts`     | The page the bot streams: plays speech in order, draws a waveform, and stops when someone talks over it   |
| `agent/tools/join_meeting.ts` | Sends a voice bot to a meeting on request, for testing                                                    |
| `agent/instructions.md`       | How to talk: short spoken sentences, no Markdown, and a heads-up line before tool calls                   |

### Linking the page to its meeting

Recall creates the bot id, so the page URL can't carry it. Instead, `voiceBotConfig` puts a random key in both the page URL and the bot's metadata. The stream route looks the bot up by that metadata in Recall, then finds its session with `resolveSession(botId)`. A page URL only ever reads its own meeting, and the route answers `425` until the meeting's session starts with its first event.

## Set up

You need a [Recall.ai](https://www.recall.ai) API key and [workspace verification secret](https://docs.recall.ai/docs/authenticating-requests-from-recallai). The agent's model and speech both go through AI Gateway, which uses Vercel OIDC when deployed, or `AI_GATEWAY_API_KEY` locally.

```bash
RECALL_API_KEY=...
RECALL_WORKSPACE_VERIFICATION_SECRET=whsec_...
RECALL_REGION=us-east-1            # your Recall workspace region
RECALL_WEBHOOK_URL=https://...     # for local development or a protected deployment
VOICE_SPEECH_MODEL=openai/tts-1    # optional; any AI Gateway speech model
VOICE_SPEECH_VOICE=alloy           # optional; a voice the speech model offers
```

This example uses the workspace builds of `eve` and `@eve/recall`. To run it outside the repository, copy the directory and replace both `workspace:*` versions with published versions that include the `routes` option on `recallChannel`.

## Run it

Deploy to Vercel, or run `pnpm dev` behind an HTTPS tunnel and set `RECALL_WEBHOOK_URL` to `https://<your-tunnel>/eve/v1/recall`. The page is served from the same origin as the webhook route, with the same query, so a protection bypass in `RECALL_WEBHOOK_URL` covers both.

Then open the terminal UI against the agent, ask it to join a meeting, and admit the bot:

```bash
pnpm exec eve remote connect --url https://<your-project>.vercel.app
# > Join https://meet.google.com/abc-defg-hij
```

To debug the page while the bot is in a call, open the bot in Recall's Bot Explorer and click **Open Remote Devtools**.

## Limits

- Latency is transcription, the `decide` check, the model's first sentence, and speech synthesis, usually a few seconds from when someone stops talking. A speech-to-speech model in the page, as in the [eve voice template](../../apps/templates/eve-voice-template), would answer faster, but the meeting's turns would no longer run through the channel.
- Barge-in is a loudness check on the meeting audio. Background noise can cut eve off; raise the threshold in `voice-page.ts` if it does.
- An interrupted reply stays whole in the session's history, so the agent doesn't know which part people heard.
- Approvals, questions, and sign-ins still go to the meeting chat as text.
- Output Media needs the `web_4_core` bot variant for smooth audio, which Recall bills at a higher rate.
