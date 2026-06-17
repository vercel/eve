# Weather agent

The weather-focused eve fixture. It backs the repo root `pnpm dev`, the
bundle-analysis workflow, and manual smoke testing as a small representative
eve app:

- `agent/agent.ts` — model config (`openai/gpt-5.5` with adaptive
  thinking)
- `agent/instructions.md` — the always-on instructions prompt
- `agent/tools/get_weather.ts` — a typed weather lookup tool
- `agent/skills/get-weather.md` — a markdown skill describing the weather
  procedure

## Run locally

```sh
pnpm dev
```

This starts the local runtime and the interactive terminal UI. No credentials
are required for the TUI.

Focused end-to-end coverage lives under [`e2e/fixtures`](../../../e2e/fixtures).
