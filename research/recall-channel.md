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
  onMeetingEvent?(ctx, event),  // route: -> { auth, message?, title? } | null
  shouldRespond?(input),        // session: does this line start a turn?
  events?: RecallChannelEvents, // merged over the defaults
});
```

`event` is a `RecallMeetingEvent`: `speech`, `chat`, `join`, `leave`, or
`status` (`call_ended`, `done`, `fatal`, …). Two hooks split the work:

- `onMeetingEvent` runs in the webhook route and decides which events enter
  the session and as whom. By default that's speech, chat, joins, and leaves,
  each as its participant.
- `shouldRespond({ event, line, transcript, botName })` runs in the session's
  `deliver` hook and decides whether a line starts a turn. A declined line
  costs no model call. It's kept in channel state (the last 60 lines) and
  given to the next turn as a `<meeting_transcript>` context block, and it
  doesn't withdraw a pending approval or question. The default answers every
  chat message and speech that names the bot. A throw falls back to that
  default.

`shouldRespond` is where a cheap decision model goes. It sees the recent
transcript, so it can tell that "can you file that?" right after a bug
discussion is meant for the bot:

```ts title="agent/channels/recall.ts"
import { decide } from "eve/ai";
import { recallChannel } from "eve/channels/recall";

export default recallChannel({
  async shouldRespond({ event, line, transcript, botName }) {
    if (event.type === "chat") return true;
    if (event.type !== "speech") return false;
    const { answers } = await decide({
      state: { assistant: botName, recentTranscript: transcript.slice(-10), latest: line },
      questions: {
        addressed: {
          type: "boolean",
          instructions: `Is the latest line asking ${botName} to do or answer something?`,
        },
      },
      abortSignal: AbortSignal.timeout(5_000),
    });
    return answers.addressed.probability >= 0.5;
  },
});
```

This replaces the template's `no_reply` tool, along with the full model call
it made for every utterance.

Building blocks are exported for code outside the channel, such as a
`join_meeting` tool or Recall calendar auto-join: `recallBotConfig` (the
`POST /bot/` body the channel needs), `createRecallBot`,
`sendRecallChatMessage`, `outputRecallAudio`, `startRecallOutputMedia`,
`stopRecallOutputMedia`, `leaveRecallCall`,
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
  a `<recall_context>` block and any `<meeting_transcript>` the agent heard
  but didn't answer. Pending prompts resolve against the raw words:
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

## Decided

- **Per-participant principals** are the default. `recallMeetingAuth` stays
  exported for agents that want one principal per meeting.
- **No voice replies.** Recall has no TTS; `output_audio` only plays a clip
  you supply.

## Limits of `shouldRespond`

- A declined line during a turn held on a prompt is dropped from the
  transcript, because eve restores channel state when it ignores a delivery
  mid-turn.
- Under `queue`, lines spoken during a running turn are delivered when it
  ends, and each runs `shouldRespond` then.
- Each declined line still costs a workflow step and one decision call.
- `queue` with an open question can stall: a message that doesn't answer the
  question waits for the turn to end, but the turn is waiting on the question.
  This is recorded as broken in the matrix and is being investigated
  separately.

## Output Media

Output Media streams a web page into the meeting as the bot's camera and
microphone. The page can play audio and read meeting audio and the live
transcript. The spike exposes only primitives:

- `recallBotConfig({ outputMediaUrl })`, set at creation;
- `RecallHandle.startOutputMedia(url)` and `stopOutputMedia()`;
- `startRecallOutputMedia` and `stopRecallOutputMedia`.

A real surface could be a _meeting screen_. The channel would serve a page
for each bot, and the page would follow the session stream through
`eve/client`. The agent could then show things to the meeting: the issues it
filed, an agenda, or a diagram. That's beyond chat, which is capped at 500
characters on Meet. Open questions:

- **Page authorization.** Recall's headless browser loads a bare URL, so
  access would rely on a short-lived signed token in that URL.
- **Who renders the page.** eve could ship a default page, or authors could
  point at their own app.
- **How the agent puts things on screen.** Options are a provided tool such as
  `show_on_screen`, or the page rendering the stream itself.
- **Recall constraints.** Output Media is not available in Slack huddles, and
  it can't be combined with `output_audio`.

## Open questions

1. **Own-message detection.** Recall documents no bot participant id or
   `is_bot` flag, nor whether the bot's chat echoes back. The spike matches the
   display name, which drops a human with the same name.
2. **Webhook deduplication.** Retries carry the same `webhook-id`. Ack-first
   handling makes retries rare, but deduplication would need a store the route
   doesn't have.
3. **Session end.** Status webhooks arrive at the same route, but they're
   configured in the Recall dashboard and the default hook drops them. A
   `call_ended` could reset the session or prompt a post-meeting summary;
   `transcript.done` enables a full-transcript recap.

## Not yet covered

`eve setup` integration, docs page, catalog entry, changeset, platforms
without chat (Webex can't send, Slack huddles can't receive), live
verification against Zoom, Meet, and Teams.
