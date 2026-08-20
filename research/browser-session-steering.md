---
issue: "483"
status: implemented
last_updated: "2026-08-14"
---

# Browser sessions can submit while a turn is active

eve already accepts ID-addressed messages with `turnPolicy: "queue"` or
`turnPolicy: "steer"`, but the frontend bindings reject every `send()` while
their current turn is submitted or streaming. Browser applications therefore
cannot use the runtime policy without bypassing `useEveAgent()` and rebuilding
its stream and projection state.

## Authoring API

`send()` accepts an explicit turn policy while a turn is active. A queued
message waits for the current turn; a steering message durably buffers its
replacement before the runtime cancels the current turn.

```tsx
const agent = useEveAgent();

await agent.send("Use this after the current response.", {
  turnPolicy: "queue",
});

await agent.send("Replace the current response with this.", {
  turnPolicy: "steer",
});
```

An overlapping send without an explicit `turnPolicy` continues to reject. This
preserves the existing guard against accidental double submission while making
the two active-turn behaviors intentional at each call site.

The binding exposes accepted overlapping messages separately from the active
turn:

```tsx
for (const submission of agent.pendingSubmissions) {
  console.log(submission.message, submission.status);
}
```

Each pending submission has a browser-generated ID, its flattened display
message, its requested policy, and one of `submitting`, `queued`, `steering`, or
`failed`. `status` continues to describe server execution: `submitted`,
`streaming`, `ready`, or `error`.

## Lifecycle

The frontend store owns one resumable session stream instead of consuming one
response stream per `send()`. Message POSTs and event streaming are independent:

```text
send(queue) ──202 accepted──▶ pending submission
                                  │
session stream ──turn boundary────┼──turn.started──message.received──▶ transcript
                                  │
send(steer) ──202 accepted────────┘  (runtime cancels the previous turn)
```

After a successful delivery, `send()` resolves when eve accepts it. Turn
completion stays observable through reactive state and `onFinish`. This is a
breaking change to the previous promise timing, but it avoids making a queued
send wait for an unbounded amount of time or pretending that one queued message
always maps to one turn. eve may coalesce adjacent deliveries before the next
turn.

Pending submissions are a local UI projection. They let the submitting browser
render an **Up next** or **Steering** panel, but they are not a durable,
cross-client queue listing. Accepted messages become authoritative when the
session stream emits `message.received`; a later protocol can add durable
delivery identities if cross-refresh queue reconstruction or selective queue
management becomes necessary.

## Durable cancellation integration

Queueing and cancellation remain independent runtime commands, but share one
browser stream owner. The store's session follower is the event authority and
tracks the current `turn.started` ID for `cancel()`. Independent message POSTs
never consume their own `MessageResponse` streams, so overlapping sends cannot
claim the same active turn or race a later cancellation boundary.

`MessageResponse.cancel()` remains available to lower-level clients that own
one serialized response. The frontend store instead guards cancellation with
the active turn ID observed by its shared follower.

## Scope boundaries

- `respond()` remains serialized and never steers.
- Submission policy and durable cancellation remain separate commands; their
  browser stream ownership is coordinated as described above.
- The first message creates the session, so its turn policy has no active turn
  to affect.
- This change does not add removal, reordering, or selective promotion of an
  accepted queued message.
- Cancelling an active turn with buffered queued messages causes the runtime to
  process those messages next; several buffered messages may share one turn.
