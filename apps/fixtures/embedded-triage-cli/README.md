# Embedded support triage CLI

This private fixture is an architectural spike that embeds eve behind a support-ticket triage CLI. It has no `agent/` directory. The application defines one embedded agent in `embedded-agent.mjs`, runs it through a local durable Workflow executor, and produces schema-constrained JSON.

From the repository root, run the sample ticket:

```sh
pnpm --filter embedded-triage-cli embedded-triage run ./sample-ticket.json
```

Build the production application:

```sh
pnpm --filter embedded-triage-cli embedded-triage build
```

The build uses eve's production application pipeline and includes the Workflow flow handler. This spike does not prove a remote deployment, external idempotency, concurrent embedded executors, multiple agents, human input, or sandbox and authentication ownership. The `eve/embedded` API is experimental and has no compatibility guarantee.
