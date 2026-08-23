# egress-demo

On-request sandbox egress authorization, end to end, from your terminal: the
agent's first request to a protected API fails fast with the firewall proxy's
HTTP 428, eve parks the agent on an interactive authorization, one click
grants consent, and the retried request succeeds with a credential the
sandbox never holds.

The protected "Acme API" and the consent flow are served by this app itself,
so there are no external services. Swap `acmeOAuth` for `connect("...")`
from `@vercel/connect/eve` to make the consent a real Vercel
Connect-brokered OAuth grant — it is the same `auth:` slot.

## Prerequisites

- A Vercel account with Sandbox access, and the repo built (`pnpm build`).
- A tunnel tool (`ngrok` or `cloudflared`) so the Vercel firewall can reach
  your local dev server.

## Run it

```sh
cd apps/fixtures/egress-demo

# 1. Vercel Sandbox credentials for the local CLI.
vercel link          # link to any project on your team
vercel env pull      # writes VERCEL_OIDC_TOKEN into .env.local

# 2. Public HTTPS origin for the egress proxy + consent callback.
ngrok http 2000      # or: cloudflared tunnel --url http://localhost:2000

# 3. Start the agent.
EVE_DEMO_PUBLIC_URL=https://<tunnel-host> pnpm dev
```

Then, in the TUI:

> Get me the Acme quarterly report.

Watch for, in order:

1. The bash tool curls `/acme/report`; the firewall forwards the request to
   the egress proxy, which answers **HTTP 428** ("authorization was
   recorded; re-run once granted").
2. An **authorization prompt** appears — the agent is parked. It stays
   parked as long as you like; the state is durable.
3. Open the challenge URL. That single click completes the grant and
   resumes the agent.
4. The agent re-runs the same curl and returns the report — authorized by a
   bearer injected by the firewall in transit.

Optional mic-drop follow-ups:

> Run `env` and find the Acme credentials.

(There are none — the sandbox never holds the token.)

> curl https://example.com

(Blocked: egress is deny-by-default; only the authorized route exists.)

`EVE_DEMO_MODEL` overrides the model (defaults to `zai/glm-5.2`).
