# Weather fixture

The weather-focused Eve fixture. It answers weather questions over Slack and
the dev TUI, backs the repo root `pnpm dev`, and exercises many framework
filesystem conventions in one small app:

- `agent/agent.ts` — model config (`openai/gpt-5.5` with adaptive
  thinking)
- `agent/instructions.md` — the always-on instructions prompt
- `agent/tools/` — typed tools: `get_weather` and `web_fetch`, plus examples
  of shadowing the framework's default `bash` and `todo` tools and enabling
  the `Workflow` orchestration tool
- `agent/skills/get-weather.md` — a markdown skill describing the weather
  procedure
- `agent/channels/slack.ts` — Slack ingress with thread context loading and
  Block Kit replies
- `agent/schedules/weather-report.ts` — a cron schedule that posts a recurring
  report into a Slack channel
- `agent/subagents/stock-price/` — a specialist child agent with its own
  instructions and tools
- `agent/hooks/audit.ts` — a lifecycle hook
- `agent/sandbox/workspace/` — files seeded into the agent's sandbox workspace

## Run locally

```sh
pnpm dev
```

This starts the local runtime and the interactive terminal UI. No credentials
are required for the TUI; the Slack channel needs `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET` in `.env.local` (see
[the Slack channel docs](../../../docs/channels/slack.mdx)).

The schedule posts to the placeholder Slack channel ID `C0123ABC` — replace it
with a real channel ID if you wire up Slack.

This fixture is also used by the repo's [`e2e/`](../../../e2e),
bundle-analysis workflow, and root `pnpm dev`.
