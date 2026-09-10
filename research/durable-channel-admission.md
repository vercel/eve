---
issue: https://github.com/vercel-labs/agent-factory/pull/392
status: proposed
last_updated: "2026-09-10"
---

# Durable channel admission

Factory acknowledges Slack events before the asynchronous channel send finishes. An application
inbox can retry those events, but a lost send response currently risks another turn. Channel
startup may also return a provisional session that loses continuation ownership.

Add `from(address).open({ auth, state })` to open an idle conversation and return its canonical
owner. It starts no model turn. The application persists the returned session ID alongside its
verified event before calling `attachSession(id).send(message, { auth, operationId })`.
Operation identity is scoped to the immutable session and authenticated principal. Repeated
operations are consumed once by the durable driver; the first payload wins. Responses expose the
stable delivery ID, which correlates with turn events. Public calls require a driver capability
marker so existing pinned sessions reject unsupported guarantees before accepting input.

An application owns persistence before webhook acknowledgement, replay scheduling, and retention.
It must retain the chosen session ID, never re-resolve an old operation to a replacement session.
An inactive target returns `session_not_active`; the owner reconciles its retained transcript or
surfaces an unresolved delivery. Session reset does not silently send accepted work elsewhere.
Idempotency lasts for the target session's retained workflow history.

Slack channels can opt into `admitMessage(message, { waitUntil })`, awaited after verification
and before acknowledgement. A failed persistence call returns HTTP 503. The application stores
the normalized message, then calls `channel.prepareMessage(storedMessage, routeContext)` from a
trusted worker. Preparation retains the authored auth hooks, attribution, upload policy and
private-channel classification without creating or sending to a session. Persist its JSON-safe
result before opening an idle session. This opt-in covers mentions and DMs; interactivity and
other event handlers retain their existing behavior.

`getSessionOperationDeliveryId({ sessionId, operationId, auth })` exposes correlation before
sending so a lost response followed by session retirement can still be reconciled. The
application owns the inbox store and maintenance; eve does not supply an application queue.

`SessionHistoryUnavailableError` distinguishes provider-reported missing/expired history from
transient stream-tail read failures, so maintenance can surface permanently unresolved admissions.
