# egress-demo

Interactive sandbox egress authorization, end to end: the agent runs in a
Vercel Sandbox with deny-by-default network egress, a protected route parks
the agent on a real consent, one click grants it, and the agent resumes with
a route it could not reach before — authorized by policy, never by a
credential inside the sandbox.

Swap `acmeOAuth` for `connect("...")` from `@vercel/connect/eve` to make the
consent a real Vercel Connect-brokered OAuth grant — it is the same `auth:`
slot.

## Mode 1 — fully local CLI (start here)

The protected route is a real public API (`api.github.com`), resolved
eagerly: opening the sandbox parks the agent on the consent, and the
callback is served by your local dev server. Nothing needs to reach your
laptop from outside.

```sh
cd apps/fixtures/egress-demo
vercel link          # any project on your team — just for Sandbox credentials
vercel env pull      # writes VERCEL_OIDC_TOKEN into .env.local
pnpm dev
```

In the TUI:

> Fetch me some GitHub zen.

1. The bash tool opens the sandbox; eager resolution hits the interactive
   provider → **authorization prompt**, agent parked (durably — take your
   time).
2. Open the challenge URL; one click completes the grant and resumes the
   agent.
3. The same curl now succeeds: the firewall route exists only because you
   consented.
4. Follow-up: `curl https://example.com` — blocked; egress is
   deny-by-default.

The same flow runs unattended as an eval — the harness authenticates as a
synthetic user and fetches the consent callback itself:

```sh
eve eval latency-probe
```

## Mode 2 — on-request 428 flow (runs on a Vercel deployment)

The full fail-fast loop — first request answered 428 by the egress proxy,
demand settled after the command exits — requires the Vercel firewall to
reach this app's own public HTTPS origin: the proxy verifies the
firewall's OIDC token with the request URL as its audience, so the proxy
must serve on the exact origin it is addressed by. Deploy the app:

```sh
vercel deploy        # this app; note the deployment URL
eve dev https://<deployment-url>   # local TUI, remote agent
```

On the deployment the mode switches automatically (`VERCEL_URL`), the
protected route is this app's own `/acme/report`, and the demo prompt is:

> Get me the Acme quarterly report.

Expect: curl → **HTTP 428** ("authorization was recorded…") → consent →
retry succeeds with the firewall-injected bearer.

`EVE_DEMO_MODEL` overrides the model (defaults to `zai/glm-5.2`).
