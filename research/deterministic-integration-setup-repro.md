---
issue: https://github.com/vercel/eve/issues/1786
status: in-progress
last_updated: "2026-08-07"
---

# Reproduction: deterministic integration setup (#1786)

Branch under test: `cursor/deterministic-integration-setup-c02c`

## A. Reproduce the problem on CURRENT eve (`main`, before this fix)

### A1. Code evidence: runner always hardcodes interactive Asker

On `main`, `packages/eve/src/setup/integrations/runner.ts` always does:

```ts
asker: interactiveAsker(options.prompter),
```

There is no `headless` / `answers` option. A coding agent cannot inject keyed
answers; every semantic decision goes through TTY prompts.

### A2. Code evidence: `ensureVercelProject` surprise-opens interactive linking

On `main`, `packages/eve/src/setup/flows/ensure-vercel-project.ts`:

1. Reads the on-disk link.
2. If missing, always builds `interactiveAsker` + `runInteractive` (team/project
   pickers) — even when the caller is already mid Discord/Linear/GitHub setup.

Discord calls this **after** collecting the bot token and **before**
provisioning Connect (`packages/eve/src/setup/integrations/discord/setup.ts`).
So a headless agent that somehow answered earlier prompts can still be dropped
into an interactive Vercel link wizard mid-flow.

### A3. Why replay after partial mutation is unsafe

Discord (and Linear/GitHub similarly) interleaves decisions with mutations:

1. Ask bot token / command fields (or branching Linear connector choices).
2. Call Discord/Connect APIs (`resolveApplication`, then later
   `provisionConnector`, `registerCommand`, `configureEndpoint`).
3. Write `agent/channels/discord.ts`.

If the process dies after `provisionConnector` but before the channel file is
written, re-running the interactive flow can create a **second** connector or
re-register commands while the agent cannot reliably re-answer the same
branching prompts. That is why gather must complete before perform, and why
perform must be idempotent or fail closed.

### A4. Unit tests that FAIL on `main` and PASS on this branch

From repo root on `main` (before this change), these tests do not exist yet.
After cherry-picking only the new test files onto `main` without the
implementation, they fail because:

- `composeIntegrationAsker` / `RunIntegrationSetupOptions.headless` are missing
- `ensureVercelProject({ headless: true })` opens interactive boxes instead of
  throwing `HumanActionRequiredError`
- Discord does not pass `headless` into `ensureVercelProject`

Commands (after this branch’s tests exist; compare against `main`):

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts \
  src/setup/integrations/runner.test.ts \
  src/setup/integrations/discord/setup.test.ts \
  src/setup/flows/ensure-vercel-project.test.ts
```

Optional CLI illustration (needs a real eve project + TTY; no credentials
required to _see_ prompts start):

```sh
# In an eve agent directory that is authenticated but NOT linked:
eve add discord
# → branching / password prompts; no answers-by-key contract
```

## B. Verify AFTER this change

### B1. Branch and files

- Branch: `cursor/deterministic-integration-setup-c02c`
- Key files:
  - `packages/eve/src/setup/integrations/runner.ts` — headless Asker composition
  - `packages/eve/src/setup/integrations/types.ts` — `headless` on context
  - `packages/eve/src/setup/flows/ensure-vercel-project.ts` — fail closed headless
  - `packages/eve/src/setup/integrations/discord/setup.ts` — gather then perform
  - unit tests listed below
  - `research/deterministic-integration-setup.md`
  - `.changeset/deterministic-integration-setup.md`

### B2. Headless answers-by-key (unit)

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts \
  src/setup/integrations/runner.test.ts \
  src/setup/integrations/discord/setup.test.ts \
  src/setup/flows/ensure-vercel-project.test.ts
```

Expected:

- `composeIntegrationAsker` headless + answers resolves without TTY
- missing required key → `InteractionRequired`, no Discord/Connect mutation
- `ensureVercelProject({ headless: true })` with no link →
  `HumanActionRequiredError` (`vercel-link`)
- interactive path still answers via prompter
- Discord passes `headless: true` into `ensureVercelProject`

### B3. Cheap workspace checks

```sh
pnpm fmt
pnpm lint
pnpm --filter eve typecheck
```

### B4. Programmatic headless shape (what agents will call)

```ts
import { runIntegrationSetup } from "eve/..."; // internal runner today

await runIntegrationSetup("discord", {
  appRoot,
  prompter, // unused for questions when headless + answers cover required keys
  headless: true,
  answers: {
    "discord-bot-token": process.env.DISCORD_BOT_TOKEN,
    "discord-command-name": "ask",
    "discord-command-description": "Ask the eve agent",
  },
});
```

If the directory is not linked, expect `HumanActionRequiredError` with
`command: "vercel link"` **before** Connect provisioning — complete linking
separately, then retry.
