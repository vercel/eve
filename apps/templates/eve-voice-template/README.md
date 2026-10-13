# eve Voice Template

A Next.js voice app for [eve](https://eve.dev). You talk to an eve agent in the browser. OpenAI's GPT-Live-1, through Vercel AI Gateway, does the listening, speaking, and turn-taking. Your eve agent does the work: it runs tools, asks for approvals, and keeps the conversation's durable state.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=Talk%20to%20an%20eve%20agent%20in%20the%20browser%20with%20GPT-Live-1%20on%20AI%20Gateway.&demo-title=eve%20Voice%20Template&env=AI_GATEWAY_API_KEY,EVE_VOICE_PASSWORD&envDescription=An%20AI%20Gateway%20API%20key%20for%20GPT-Live-1%2C%20and%20a%20strong%20password%20that%20protects%20the%20app%20%2816%2B%20characters%20recommended%29.&from=templates&project-name=eve%20Voice%20Template&repository-name=eve-voice-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-voice-template)

## Quick start

1. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication). GPT-Live-1 client secrets can only be minted with an API key; Vercel OIDC is not accepted for that endpoint.
2. Click **Deploy with Vercel** and enter `AI_GATEWAY_API_KEY` and a strong `EVE_VOICE_PASSWORD`.
3. Open the deployed app, enter the password, and click **Start call**.

Try "What's the weather in Paris?" or "Remind me to call Bob tomorrow." The reminder tool asks for approval on screen before it runs.

Voice sessions cost $3 per hour, billed by the second, including silence and time spent waiting on the agent. The agent's own model calls are billed separately. The app ends each call after 10 minutes (`MAX_CALL_SECONDS` in `apps/web/lib/voice-config.ts`).

## How it works

```
Browser
 ├─ @ai-sdk/react useRealtime ── WebSocket ──▶ AI Gateway (openai/gpt-live-1)
 │     microphone and speaker audio            delegation: client
 │     delegation-created ─┐
 │                         ▼
 ├─ eve/client ── /eve/v1/session ──▶ eve agent (tools, approvals, durable session)
 │     agent progress  ──▶ context-append (thinking, silent)
 │     agent answer    ──▶ context-append (commentary, spoken)
 └─ POST /api/live/client-secret ──▶ single-use Gateway client secret
```

- **Audio goes directly from the browser to AI Gateway.** The server only mints a short-lived, single-use client secret (`apps/web/app/api/live/client-secret/route.ts`). The browser passes it as a WebSocket subprotocol, and the Gateway API key never leaves the server. No server holds the audio stream open.
- **GPT-Live-1 delegates instead of answering.** Its instructions (`LIVE_INSTRUCTIONS`) tell it to hand off anything beyond small talk. A delegation event has an ID but no request text, so the app sends eve whatever the user said since the previous delegation.
- **One call is one durable eve session.** `apps/web/lib/voice-delegate.ts` creates the session on the first delegation and continues it for later ones, one at a time. Each turn carries ephemeral `clientContext` that asks for short, spoken-style answers. The agent's `instructions.md` therefore doesn't need to know about voice.
- **Progress is silent; answers are spoken.** Tool calls are appended on GPT-Live-1's `thinking` channel, which the model can use while it fills the wait. The agent's final answer is appended on the `commentary` channel, which the model says out loud in its own words.
- **Approvals stay on screen.** When eve asks for input, the app shows the prompt in the browser and tells the voice model to point the user at it. The voice model never answers approvals.
- **Hanging up stops the agent.** Interrupting GPT-Live-1 only changes what it says; eve keeps working. Ending the call cancels any in-flight eve turn.

## Deployment modes

The modes and their precedence match the [eve chat template](../eve-chat-template).

| Mode              | Selected when                                                       | Authentication                            |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Starter           | `EVE_VOICE_PASSWORD` is configured                                  | Shared password and secure session cookie |
| Production        | Neon, Upstash, and all Sign in with Vercel variables are configured | Better Auth with Sign in with Vercel      |
| Local development | Neither mode is configured and `next dev` is running locally        | Local development identity                |

Every mode also requires `AI_GATEWAY_API_KEY`. In production mode, Upstash also rate limits client-secret minting to 20 calls per user per hour.

Starter mode is for one trusted operator: everyone who knows the password shares one agent identity.

To upgrade a linked project to production mode, run the setup script. It stores your Gateway key, provisions Neon and Upstash, registers Sign in with Vercel, pulls environment variables, and runs migrations:

```bash
./scripts/setup.sh
# Or: ./scripts/setup.sh --scope <team-slug>
```

## Run locally

```bash
pnpm install
cp .env.example .env.local   # then set AI_GATEWAY_API_KEY
pnpm dev:all                 # web app and eve agent (Vercel CLI 59.16.0 or newer)
```

Open http://localhost:3000 and allow microphone access. `pnpm dev` starts only the Next.js app, and `pnpm dev:eve` starts only the agent with the eve terminal UI.

## Customize

- **Agent:** `agent/agent.ts` (model), `agent/instructions.md`, and `agent/tools/`. Every voice request waits on this model, so a fast model keeps calls responsive.
- **Voice behavior:** `apps/web/lib/voice-config.ts` holds GPT-Live-1's instructions, the per-turn voice context sent to eve, and the call length cap.
- **Delegation:** `apps/web/lib/voice-delegate.ts` decides what reaches GPT-Live-1 while eve works. Each append must stay under GPT-Live-1's 500-token limit.

## Limitations

- GPT-Live-1 on AI Gateway supports WebSocket transport with client delegation only. WebRTC, hosted Responses delegation, and live session updates are not available.
- The browser enforces the call length cap. A modified client could keep a session open up to GPT-Live-1's own session limit, so keep the token route behind authentication and rate limiting.
- Calls are not persisted. Reloading the page ends the call, and the next call starts a new eve session.
- Connection sign-in prompts (`authorization.required`) are not handled, because the template's agent has no connections.
