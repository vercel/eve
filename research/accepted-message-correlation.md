---
issue: https://github.com/vercel/eve/issues/2461
status: implemented
last_updated: "2026-09-06"
---

# Accepted message correlation

A persisted client cursor may precede completed or active turns. Reading from
that cursor until the first waiting boundary can silently return an old result.
A tail refresh alone still races with an active or queued turn.

Keep the existing client authoring API. The session POST acknowledgement includes
the existing server-issued `deliveryId`; events for the accepted message carry
that identity in optional `meta.deliveryIds`. An array accounts for coalesced
messages. The runtime retains these identities across workflow steps and through
cancellation, replacing them when it applies new message input.

`ClientSession.send()` skips earlier deliveries before collecting its response.
The cursor still advances over skipped events. A missing acknowledgement identity
or a terminal session before the matching delivery is an explicit error. Initial
session creation and input-response routing retain their existing read behavior.

The additional metadata is compatible with persisted events: historical events
need no rewriting, and new messages acquire an identity when accepted. Upgrade
the server with the client; a client must not guess which message an older server
accepted. Event IDs continue to identify individual stored events, independently
of delivery identity.
