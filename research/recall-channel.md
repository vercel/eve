---
issue: TBD
status: spike
last_updated: "2026-10-15"
---

# Recall.ai meeting channel

> **AI status:** Written entirely by AI; human review pending.

`eve/channels/recall` turns a Recall.ai meeting bot into an eve channel. Each
bot's meeting is one session. Speech and chat arrive through Recall's real-time
webhooks, and the agent replies in the meeting chat. The spike lives in
`packages/eve/src/public/channels/recall/` and passes the channel conformance
suite in three columns (`recall`, `recall-speech`, `recall-google-meet`).

## Authoring API

```ts title="agent/channels/recall.ts"
import { recallChannel } from "eve/channels/recall";

export default recallChannel();
```

Reads `RECALL_API_KEY`, `RECALL_WORKSPACE_VERIFICATION_SECRET`, and
`RECALL_REGION`, and mounts `POST /eve/v1/recall` for both real-time and bot
status webhooks.

```ts
recallChannel({
  credentials?: { apiKey?, verificationSecret? },
  region?: string,
  route?: string,               // default "/eve/v1/recall"
  botName?: string,             // default "eve": addressing + own-message filter
  webhookUrl?: string,          // for bots `receive` creates
  turnPolicy?: TurnPolicy,      // default "queue"
  onMeetingEvent?(ctx, event),  // -> { auth, message?, title? } | null
  events?: RecallChannelEvents, // merged over the defaults
});
```

`event` is a `RecallMeetingEvent`: `speech`, `chat`, `join`, `leave`, or
`status` (`call_ended`, `done`, `fatal`, …). The default hook dispatches
every chat message and only the speech that names the bot, each as its
participant. The meeting-agent template, which listens to everything as one
principal, becomes:

```ts
import { recallChannel, recallMeetingAuth } from "eve/channels/recall";

export default recallChannel({
  onMeetingEvent: (_ctx, event) =>
    event.type === "speech" || event.type === "chat" || event.type === "join"
      ? { auth: recallMeetingAuth(event) }
      : null,
});
```

Building blocks are exported for code outside the channel, such as a
`join_meeting` tool or Recall calendar auto-join: `recallBotConfig` (the
`POST /bot/` body the channel needs), `createRecallBot`,
`sendRecallChatMessage`, `outputRecallAudio`, `leaveRecallCall`,
`callRecallApi`, `parseRecallEvent`, and `verifyRecallWebhook`. The
`receive` target `{ meetingUrl, metadata? }` sends a new bot and starts its
session, so another channel can hand a request into a meeting.

## Semantics

- **Address and session:** `from(botId)`. Participant ids are scoped to one
  bot, so nothing carries over between meetings.
- **Principal:** `recall:<botId>:<participantId>`, `principalType: "user"`.
  Names, host flags, and emails come from the meeting platform and are not
  verified (Recall's emails are fuzzy calendar matches).
- **Model input:** `Alice: …` for speech, `Alice (in chat):\n…` for chat, plus
  a `<recall_context>` block. Pending prompts resolve against the raw words:
  "Eve, approve." answers an approval as `approve`.
- **Replies:** `message.completed` posts to the chat, including text before a
  tool call. Messages are split at the platform limit (Meet 500, Zoom and
  Teams 4096). Approvals and questions use the text prompt queue, like Twilio.
- **Sign-ins:** a link or code is a credential. It goes to the participant by
  Zoom direct message. Other platforms have no private chat, so the bot says
  to connect outside the meeting. Instructions without a link or code are
  posted for everyone.
- **Webhooks:** Recall retries any non-2xx every second for a minute, so the
  route verifies, caps the body at 256 KiB, and acknowledges before dispatch.
  It also acknowledges a signed body it can't parse.

## Decisions to make

1. **Ambient listening.** A meeting agent wants to hear everything but speak
   rarely. Today every dispatched utterance is a model call, and each one
   withdraws pending prompts. The default avoids both by dispatching only
   addressed speech, at the cost of context. The real fix is core: a
   context-only delivery that records a line in history without starting a
   turn or counting as a reply. That would also replace the template's
   `no_reply` tool.
2. **Principal default.** Per-participant principals pass the caller and
   requester-only approval rules. They also make `queue` start a separate
   turn per speaker, where one meeting principal batches a burst into one
   turn. The spike defaults to per-participant and exports `recallMeetingAuth`.
3. **`queue` with an open question.** A message that doesn't answer the
   question waits for the turn to end, but the turn is waiting on the
   question. Approvals are cancelled by the same message, so this looks like a
   core inconsistency. It's recorded as broken in the matrix.
4. **Voice replies.** Recall offers two paths:
   - `output_audio` plays an MP3 clip. It requires `automatic_audio_output` at
     bot creation and can't be combined with output media. That makes it fine
     for short TTS replies, at the cost of a TTS step and seconds of latency.
   - Output Media renders an eve-hosted web page as the bot's camera and
     microphone. The page hears meeting audio and plays a realtime voice
     model's audio. That's the low-latency voice-agent path, but it's a
     separate realtime runtime beside the session, not a channel reply.

   The spike exposes only `RecallHandle.outputAudio`. A `reply: "chat" |
"voice"` option would need a TTS provider abstraction.

5. **Own-message detection.** Recall documents no bot participant id or
   `is_bot` flag, nor whether the bot's chat echoes back. The spike matches the
   display name, which drops a human with the same name.
6. **Webhook deduplication.** Retries carry the same `webhook-id`. Ack-first
   handling makes retries rare, but deduplication would need a store the route
   doesn't have.
7. **Session end.** Status webhooks arrive at the same route, but they're
   configured in the Recall dashboard and the default hook drops them. A
   `call_ended` could reset the session or prompt a post-meeting summary;
   `transcript.done` enables a full-transcript recap.

## Not yet covered

`eve setup` integration, docs page, catalog entry, changeset, platforms
without chat (Webex can't send, Slack huddles can't receive), live
verification against Zoom, Meet, and Teams.
