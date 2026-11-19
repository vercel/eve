---
issue: https://github.com/vercel/eve/pull/6534
status: proposed
last_updated: "2026-11-17"
---

# Human takeover of the agent's browser or desktop

A person can take over the screen an agent is using in its sandbox, do a step
only they can do (sign in, enter a one-time code, solve a CAPTCHA), and hand
control back. The agent never handles the secret, and nobody pastes it into
chat.

## Authoring API

```ts
// agent/lib/takeover.ts
import { defineTakeover } from "@eve/takeover/core";
import { appSession } from "./auth";

export const takeover = defineTakeover({
  secret: process.env.TAKEOVER_SECRET!, // >= 32 chars; never enters the sandbox
  auth: [appSession()], // route auth for the viewer page (cookie-based)
  isRequester: (viewer, requester) => sameUser(viewer, requester), // optional
  signInUrl: (returnTo) => `/signin?next=${encodeURIComponent(returnTo)}`, // optional
});

// agent/extensions/takeover.ts: serves GET /takeover/:grant and POST /takeover/:grant/token
import takeoverViewer from "@eve/takeover";
import { takeover } from "../lib/takeover";
export default takeoverViewer({ takeover });

// agent/extensions/browser.ts: adds browser__takeover
import browser from "@eve/agent-browser";
import { takeover } from "../lib/takeover";
export default browser({ takeover });
```

`@eve/agent-desktop` takes the same `takeover` option and adds
`desktop__takeover`. A screen extension contributes a `TakeoverSource`:

```ts
interface TakeoverSource {
  label: string; // "browser", "desktop"
  protocol: "screencast" | "rfb"; // what the viewer renders
  upstream: "websocket" | "tcp"; // how the proxy reaches the stream
  prepare(sandbox): Promise<{ portCommand: string } | { unavailable: string }>;
  release?(sandbox): Promise<void>;
}
```

## Lifecycle

```
tool call ── prepare source ── ctx.getToken(takeover sign-in) ─┐ throws: park
                                                               │
eve: startAuthorization(callbackUrl)                           │
  ├─ start proxy in sandbox (token-gated, stream only)         │
  ├─ expose its port (PortExposer; Vercel Sandbox routes)      │
  └─ challenge.url = /takeover/<sealed grant incl. callbackUrl>│
                                                               ▼
person ── opens link ── viewer auth + isRequester ── stream token ── wss://sandbox/stream
       ── Done ── opens eve's callbackUrl ── completeAuthorization ── call re-runs, gets token
tool ── close proxy, unexpose port, release source ── { status: "done" }
```

The wait is eve's interactive sign-in, not a workflow: extensions cannot
contain workflow directives, and a sign-in is the durable, requester-scoped
human wait ordinary tools already have. Its prompt is shown only to the person
who asked, it survives restarts, `expiresAt` bounds it, and a new message
withdraws it. Cancel opens the callback with `error=access_denied`.

## Invariants

- Only the requester opens the viewer: the sealed grant records the turn's
  principal and the viewer route admits only a matching signed-in viewer.
- Stream tokens are Ed25519-signed by the agent server, name one session and
  call, live at most two minutes, and are accepted once. The sandbox holds only
  the public key.
- The proxy exposes only `/stream`, requires the agent's origin, forwards
  neither Origin nor cookies, logs nothing, and exits at the takeover's limit.
- Keystrokes go browser → sandbox directly and never pass through the agent
  server.

## Limitations

- The model shares the sandbox with the screen, so a hostile turn could plant a
  listener before asking. Takeover keeps secrets out of transcripts, model
  context, and logs; it does not defend against a compromised agent.
- After Done, the agent sees whatever the signed-in account shows.
- Device-bound SSO, passkeys, and security keys cannot pass through a stream.
- A sign-in that expires without a callback leaves the port exposed with no
  proxy behind it until the next takeover or the session ends.
- Exposing a port is provider-specific. A first-class sandbox API for it would
  remove `PortExposer`.
