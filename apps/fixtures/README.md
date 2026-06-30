# App fixtures

These apps are shared development fixtures. They are real eve apps that CI or
local smokes may build and boot, so package names are part of the test target
surface.

- `weather-agent` backs root `pnpm dev`, manual weather-agent smokes, and bundle analysis.
- `agent-tui-client` backs the non-e2e TUI smoke scripts in `packages/eve/test/tui-client`.

When adding fixture behavior, prefer extending an existing fixture unless the new behavior needs incompatible app-level configuration.
