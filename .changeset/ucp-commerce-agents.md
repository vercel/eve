---
"eve": patch
---

Add `eve/commerce/ucp` for building agents that buy over the Universal Commerce
Protocol. `defineUcpConnection` connects to a merchant's UCP shopping service
and takes the protocol headers off the model — agent profile identity,
retry-safe `Idempotency-Key`/`Request-Id` derived from the replay-stable call
id, and RFC 9421 request signing. `resolveUcpCheckoutHandoff` collapses a
checkout response into one typed outcome: conversational continuation,
`continue_url` redirect, or embedded checkout.

OpenAPI connections also gain a `prepareRequest` hook, which receives the
fully-built request — including the serialized body — and merges the headers it
returns. Use it for signatures and content digests that `headers` cannot
express.
