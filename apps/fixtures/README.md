# App fixtures

These apps are test fixtures. They are real Eve apps that CI builds and boots from smoke or e2e tests, so package names are part of the test target surface.

- `weather-fixture` backs root `pnpm dev`, weather-focused smokes, remote-agent smokes, and bundle analysis.
- `agent-tui-client` backs the non-e2e TUI smoke scripts in `packages/eve/test/tui-client`.

When adding fixture behavior, prefer extending an existing fixture unless the new behavior needs incompatible app-level configuration.
