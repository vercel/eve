---
issue: https://github.com/vercel/eve/issues/1159
status: in-progress
last_updated: "2026-09-15"
---

# Leased session stream responses

## Purpose

A client that abandons a session stream expects `request.signal` to release the
server-side Workflow reader. Some serverless transports do not propagate that
cancellation, so each client reconnect can leave the previous invocation alive
until the host timeout.

Treat an HTTP response as a renewable lease over the durable event stream. A
capable client opts into a bounded response, receives transport heartbeats, and
reconnects from its cursor after an explicit lease-end control record. Session
events remain durable and the public `session.stream()` API does not change.

## Wire protocol

The client advertises the control records it can decode:

```http
GET /eve/v1/session/:id/stream?streamControlVersion=1
```

For version 1, the server:

- sends an ignored blank line every ten seconds without an event, keeping the
  existing 15-second client read timer from treating a healthy response as
  stalled;
- ends the response after a fixed 60-second lease;
- writes `{"$eve":"stream.lease-ended","version":1}` immediately before the
  intentional close; and
- cancels the response's Workflow reader when the lease ends.

The client consumes the control record internally, reconnects immediately from
its absolute event cursor, and does not charge the lease renewal against its
empty-stream retry budget. EOF without the control record retains the existing
bounded, backed-off reconnect behavior.

The lease bounds cleanup even if heartbeats or the final control record are
buffered by an intermediary. In that case the client's ordinary read timeout
reconnects, while the abandoned server invocation ends no later than its lease.

## Compatibility

| Client  | Server  | Behavior                                                                       |
| ------- | ------- | ------------------------------------------------------------------------------ |
| Current | Current | Leased response with heartbeats and explicit renewal                           |
| Current | Older   | Request header is ignored; existing read timeout and reconnect behavior remain |
| Older   | Current | No capability header, so existing unleased response behavior remains           |

The capability query parameter is forwarded through remote subagent stream
proxies. An unknown control version is not negotiated. This avoids emitting records that an
older client could mistake for session events.

## Non-goals

- Changing event persistence, cursors, or the public client API.
- Solving intermediary compression independently of reconnect recovery.
- Negotiating lease duration; duration remains an eve implementation detail.
- Retrofitting bounded responses onto clients that do not advertise support.
