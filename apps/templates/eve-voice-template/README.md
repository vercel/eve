# eve Voice Template

A Next.js voice app for [eve](https://eve.dev). You talk to an eve agent in the browser. OpenAI's GPT-Live-1, through Vercel AI Gateway, does the listening, speaking, and turn-taking. Your eve agent does the work: it runs tools, asks for approvals, and keeps the conversation's durable state.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=Talk%20to%20an%20eve%20agent%20in%20the%20browser%20with%20GPT-Live-1%20on%20AI%20Gateway.&demo-title=eve%20Voice%20Template&env=AI_GATEWAY_API_KEY,EVE_VOICE_PASSWORD&envDescription=An%20AI%20Gateway%20API%20key%20for%20GPT-Live-1%2C%20and%20a%20strong%20password%20that%20protects%20the%20app%20%2816%2B%20characters%20recommended%29.&from=templates&project-name=eve%20Voice%20Template&repository-name=eve-voice-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-voice-template)

## Quick start

1. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication).
2. Click **Deploy with Vercel** and enter `AI_GATEWAY_API_KEY` and a strong `EVE_VOICE_PASSWORD`.
3. Open the deployed app, enter the password, and click **Start call**.

Try "What's the weather in Paris?" or "Remind me to call Bob tomorrow." The reminder tool asks for approval before it runs; say "approve" or click the button.

Voice sessions are billed per second, including silence and time spent waiting on the agent; see [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing). The agent's own model calls are billed separately. The app ends each call after 10 minutes.

## How it works

```
Browser
 ├─ useRealtime (@ai-sdk/react) ── WebSocket ──▶ AI Gateway (openai/gpt-live-1)
 │     │ delegations and the user's words   ▲ progress (silent), answers (spoken)
 │     ▼                                    │
 ├─ VoiceDelegate ──────────────────────────┘
 │     │ requests and spoken approvals
 │     ▼
 ├─ useEveAgent (eve/react) ── /eve/v1/session ──▶ eve agent (tools, approvals, durable session)
 │     tool calls and prompts render beside the live transcript
 └─ POST /api/live/client-secret ──▶ single-use Gateway client secret
```

- **Audio goes directly from the browser to AI Gateway.** The server only mints a single-use client secret, so the Gateway API key never reaches the browser.
- **GPT-Live-1 talks; eve works.** GPT-Live-1 delegates anything beyond small talk, and the app sends eve what the user said. One call is one durable eve session.
- **Progress is silent; answers are spoken.** The app tells GPT-Live-1 what the agent is doing, then gives it the agent's answer to say in its own words.
- **The screen shows the live transcript** as both sides speak, with eve's tool calls and prompts in place. It uses the same components as [eve Web Chat](https://eve.dev/docs/channels/eve).
- **Approvals work by voice or on screen.** The user clicks an option or says its name, such as "approve" or "cancel it, please"; anything else waits until the prompt is answered. The voice model's own words never answer a prompt.
- **Hanging up stops the agent.** Ending the call cancels any in-flight eve turn.

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

- **Agent:** `agent/agent.ts` (model), `agent/instructions.md`, and `agent/tools/`.
- **Voice behavior:** `apps/web/lib/voice-config.ts` holds GPT-Live-1's instructions, the per-turn voice context sent to eve, and the call length cap.
- **Delegation and approvals:** `apps/web/lib/voice-delegate.ts` decides what reaches eve and GPT-Live-1, and how spoken replies answer prompts.
- **Chat UI:** `apps/web/app/_components/agent-message.tsx`, `apps/web/components/`, and `apps/web/app/globals.css` come from the [eve Web Chat registry](https://eve.dev/docs/channels/eve).

## Limitations

- GPT-Live-1 on AI Gateway supports WebSocket transport with client delegation only. WebRTC, hosted Responses delegation, and live session updates are not available.
- GPT-Live-1 client secrets can only be minted with an AI Gateway API key; Vercel OIDC is not accepted.
- The browser enforces the call length cap. A modified client could keep a session open up to GPT-Live-1's own session limit, so keep the token route behind authentication and rate limiting.
- Calls are not persisted. Reloading the page ends the call, and the next call starts a new eve session.
- Spoken replies answer prompts with options, such as approvals. Free-text questions and connection sign-ins are answered on screen.
