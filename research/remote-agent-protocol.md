---
issue: https://github.com/vercel/eve/pull/4855
status: implemented
last_updated: "2026-10-26"
---

# Remote agent protocol 3: invariants and how it grows

A parent deployment delegates to a remote agent over HTTP. The parent drives the child through the
child's session routes; the child reports to the callback URL the parent gave it. This note records
what the wire guarantees, where each side tolerates additions, and what was deliberately left for
later, so a change can tell whether it needs a protocol bump.

## Invariants

- **One agreed protocol per child.** Create names the caller's version. A receiver on an earlier
  supported version refuses it before admission with `409 REMOTE_AGENT_PROTOCOL_MISMATCH`, and the
  caller negotiates once, with fresh credentials and the same `operationId` and callback token. It
  never negotiates after acceptance, an unreadable receipt, a rejection that names a session, or an
  unsupported version.
- **Callbacks say what was agreed.** Every callback URL carries `eveRemoteProtocol=<agreed>`. The
  callback route reads a body by that protocol: protocol 2 input becomes v27 relay facts, and a URL
  that names no protocol is a parent run from before v27, whose protocol 2 input passes through as
  is. Released v3 parents mint marked URLs, so a later deployment always knows what a v3-era
  callback speaks.
- **Parent requests are idempotent.** Create carries `operationId`. Follow-ups and answers to a
  protocol-3 child carry an `idempotencyKey` named by the parent's durable step; the child derives
  the delivery ID from it, so a retry after a lost response is the same delivery with the same
  receipt. Earlier protocols reject unknown fields, so the key goes only to protocol-3 children.
- **A callback nothing waits on is terminal, not a failure.** The callback route answers
  `404 { code: "CALLBACK_NOT_PENDING" }` (the message is the same in every protocol). A child retries
  a result through a short window, in case the parent hasn't registered the reply hook it sent the
  token for, then logs and keeps its session. A lost acknowledgement no longer fails the child.
- **The child decides its interactions.** The parent mirrors them and forwards answers; the child
  settles approvals and sign-ins and refuses answers it doesn't accept. A protocol 2 child reports
  no settlement for questions or budget prompts, so the parent settles those as the child takes the
  answer.

## Where each side tolerates additions

| Direction                                                        | Parser | Unknown additions                                                                                                         |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| Parent → child requests (create, message/answers, cancel, reset) | child  | Rejected (`400`, named). Create checks `protocolVersion` first, so a newer caller is refused with `409` and renegotiates. |
| Child → parent responses (create, receipt, cancel, reset)        | parent | Ignored (`z.object` strips).                                                                                              |
| Child → parent callbacks                                         | parent | Top-level fields ignored; new event types, result kinds, and fields inside `outcome` rejected.                            |

So a child can advertise a feature in a response field at any time, and a newer parent can opt in.
A parent sends a new request field only to a child that advertised it, or that agreed a newer
protocol. Kinds and event types stay strict on purpose: an ignored request or result would leave
one side waiting on nothing.

## Deferred, and how each can be added later

| Item                                                        | Why deferred                                                                                                                                                           | How it can be added                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Relay sequence numbers                                      | The child posts relays sequentially in durable steps, and the relay transition is idempotent for repeats.                                                              | Optional top-level callback field; v3 parents ignore it.                                                     |
| Running or cumulative usage; final usage on cancel or reset | v2 and v3 report one `outcome.usageDelta` per turn, and the child enforces its own budget. The gap is a parent-turn cancel, whose late result has nowhere to go.       | A `usage` field on the reset or cancel response, or a cumulative total on callbacks; v3 parents ignore both. |
| Exact answer correlation                                    | The child's delivery ID is derived from the parent's key, not equal to the parent's delivery ID, so relayed `response.*` facts match the latest open forwarded answer. | Match the derived ID on the parent, or echo the key.                                                         |
| A `turn.cancelled` result kind                              | `turn.failed` with `outcome.result.kind: "cancelled"` carries it without loss.                                                                                         | A new kind behind a protocol bump.                                                                           |
| Version-range negotiation                                   | The `409` path works; a range only saves a round trip.                                                                                                                 | v4 receivers accept a range from v5 callers.                                                                 |
| Cancel confirmation                                         | Cancel is accepted or refused; the child's cancelled turn settles on its own stream.                                                                                   | A field on the cancel response.                                                                              |
| One callback envelope                                       | Shape, not correctness.                                                                                                                                                | A protocol bump.                                                                                             |
| Protocol 1 input                                            | Protocol 1 children relay `task.*` callbacks and take answers on `/task-input/:token`. Their input still fails visibly.                                                | A protocol 1 adapter, if such children remain.                                                               |

## Known limits

- **A key reused past the window.** The HTTP route derives the delivery ID from the key. A key
  reused after 1,024 newer ones admits the input again under the same ID: readers ignore the second
  admission, and the development stream checker rejects it. Parents never reuse keys; clients must
  not reuse a key for new input.
- **Relay 404s.** An interaction relay that finds nothing pending still fails its step, as before:
  a relay is posted while the turn runs, so a parent that stopped waiting is about to cancel or
  reset the child.
- **Registration race.** The parent's reply hook can be written concurrently with the step that
  sends its token. A result that arrives before the hook exists and outlasts the retry window is
  lost, as before; the child now keeps its session instead of failing it.
