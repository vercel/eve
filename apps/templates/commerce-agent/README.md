# Commerce agent template

An eve agent that shops one merchant over the
[Universal Commerce Protocol](https://ucp.dev/), with a Next.js front end that
renders the checkout handoff.

The template is the buying side of UCP. It does not implement a store: it
talks to a merchant that already publishes a UCP profile.

## What is in here

```
agent/
  agent.ts                  the agent
  instructions.md           how it works a checkout and when it stops
  connections/merchant.ts   defineUcpConnection against the merchant endpoint
  channels/eve.ts           chat transport for the browser client
  channels/ucp.ts           this agent's own /.well-known/ucp profile
lib/ucp.ts                  identity, signing key, and a small read client
app/
  _commerce/Chat.tsx            minimal chat, tracks the active checkout id
  _commerce/CheckoutHandoff.tsx renders every branch of the handoff union
  api/checkout/[id]/route.ts    re-reads the session and resolves the handoff
```

## Setup

```sh
cp .env.example .env.local   # fill in the merchant endpoint and token
pnpm install
pnpm dev:eve                 # eve dev
pnpm dev                     # next dev, in a second terminal
```

`agent/connections/merchant.ts` throws at build time if
`UCP_MERCHANT_ENDPOINT` or `UCP_AGENT_ORIGIN` is missing, rather than sending
requests a merchant will reject.

### Local development and the agent profile

A merchant resolves who is calling by fetching the URL in your `UCP-Agent`
header, so that URL has to be reachable from the merchant's network.
`http://localhost:3000/.well-known/ucp` is not. Either point
`UCP_AGENT_ORIGIN` at a tunnel (`ngrok http 3000`), or use the example agent
profile the merchant publishes for testing, if they have one.

Check what you are serving:

```sh
curl -i "$UCP_AGENT_ORIGIN/.well-known/ucp"
```

### Signing

Signing is optional: UCP accepts an API key or OAuth token instead. Set
`UCP_SIGNING_KEY_ID` and `UCP_SIGNING_KEY_JWK` and every request is signed per
RFC 9421, with the public half published in `/.well-known/ucp` so the merchant
can verify it. Merchants that require signatures answer unsigned requests with
`signature_missing`.

## How the handoff works

The agent drives the checkout through connection tools. Each response says
what has to happen next, and `resolveUcpCheckoutHandoff` turns that into one
of three outcomes the UI can render:

- **conversational** — the agent keeps working: collect what is missing and
  call Update Checkout, or the session is ready and waiting on the buyer.
- **embedded** — the merchant enabled Embedded Checkout for this session, so
  their checkout loads in an iframe with the negotiated `ec_*` parameters.
- **continue_url** — the buyer finishes on the merchant's own site.

Plus the terminal `completed`, `canceled`, and `failed`.

The agent never places the order on its own. UCP requires the buyer to review
and authorize a checkout in a trusted UI, and the instructions in
`agent/instructions.md` hold the agent to that.

## Read next

- [UCP commerce agents](../../../docs/protocols/ucp-agent.mdx) — the preset and
  the handoff contract in detail.
- [Universal Commerce Protocol (UCP)](../../../docs/protocols/ucp.mdx) —
  publishing your own profile as a business.
