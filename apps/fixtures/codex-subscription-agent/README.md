# Codex subscription agent

This fixture proves that a ChatGPT-authenticated Codex CLI can drive an eve
agent and request an eve tool. It is intentionally local and manual. A prompt
uses the signed-in account's subscription usage.

## Run it

Sign in with the ChatGPT account whose subscription you want to test, then
build eve and start the fixture:

```sh
codex login
pnpm --filter eve build
pnpm dev
```

Ask: `Use get_weather for Boston, then state the temperature and condition.`

The terminal UI should show a `get_weather` call, its deterministic result
(`72 F`, `Sunny`), and then the final answer. That proves Codex requested the
tool while eve executed it.

For headless verification, run `pnpm exec eve dev --no-ui --host 127.0.0.1
--port 3107`, create a session at `POST /eve/v1/session`, and stream it from
`GET /eve/v1/session/:sessionId/stream`.
