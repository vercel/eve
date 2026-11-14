# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**sre** is a Slack incident response agent built on [eve](https://eve.dev). It pulls evidence from Datadog, GitHub, Slack, and Vercel. The agent lives under `agent/`.

## Setup & commands

When the user asks you to set up the project, follow [`docs/setup-for-agents.md`](./docs/setup-for-agents.md). You are already at the repo root. Do not use the Deploy button.

When the user asks for automated investigations, follow [`docs/automate-investigations.md`](./docs/automate-investigations.md) only after Slack replies work.

```bash
pnpm install          # Node 24.x (see .nvmrc)
pnpm dev              # eve TUI; run /model once to link a provider
pnpm typecheck        # tsc (TypeScript, no emit)
pnpm check            # ultracite (Biome) lint + format check
pnpm fix              # ultracite (Biome) auto-fix
pnpm test             # agent/**/*.test.ts
pnpm validate         # check + typecheck + eve info
pnpm exec eve deploy  # production deploy; do not use raw vercel deploy --prod
```

## Code style

- Linting and formatting are handled by **Ultracite** (a Biome preset). Run `pnpm check` before you finish. Run `pnpm fix` to auto-fix. Config is in `biome.jsonc`. The kebab-case filename rule is off because eve tools use snake_case names.
- TypeScript is strict. The project uses ESM with `NodeNext` resolution. Relative imports use a `.ts` extension (`allowImportingTsExtensions`). Prefer `const`, arrow functions, optional chaining, and nullish coalescing.
- Validate tool input and output with `zod` schemas.
- Do not hard-wrap prose in markdown files. Write each paragraph or bullet as one line.

## Security

- Never ask the user to paste secrets into chat.
- The user sets secrets with `vercel env add` or the Vercel project env UI. Never read `.env` files.
- Never commit secrets. `.env*` is gitignored. `.env.example` is the exception.
- Connector UIDs come from env (`SLACK_CONNECTOR`, `GITHUB_CONNECTOR`, `DATADOG_CONNECTOR`). Auth is brokered by Vercel Connect. Tokens are resolved per call and are not exposed to the model.
- `WEBHOOK_SECRET` is a shared secret for `POST /v1/investigate`. Do not put it in chat, commits, or logs.
- If you build a `RegExp` from data, escape it for a literal match and bound the input length.

## Before committing

- `pnpm validate` passes (Ultracite check, `tsc`, and `eve info` with 0 errors / 0 warnings).
- No secrets, `node_modules`, or build output (`.eve`, `.vercel`, `.output`) staged.
