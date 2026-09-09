# Compute platform development setup

This directory boots the local infrastructure through milestone A2. It applies
the owned PostgreSQL schema, starts the authenticated HTTP gateway, and starts
two supervisor processes that verify the runtime database role and schema
version. The supervisors do not schedule work or execute application code before
A3, so accepted local messages remain pending.
This setup is local only and does not perform production migration or cutover.

## Start the local platform

Requirements:

- Node.js 24 and the repository's pinned pnpm version.
- Docker with either `docker compose` or `docker-compose`.

From the repository root:

```sh
export EVE_COMPUTE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
printf '%s\n' "$EVE_COMPUTE_TOKEN"
pnpm install
pnpm compute:dev
```

The default gateway is `http://127.0.0.1:55431`, and the default PostgreSQL port
is `55432`. Set `EVE_COMPUTE_GATEWAY_PORT` or `EVE_COMPUTE_POSTGRES_PORT` before
starting to use other ports. Local-only database credentials are declared in
[`compose.yaml`](./compose.yaml); the migrator, runtime, and inspector use
separate database roles. `compute:dev` writes only the token hash to the ignored,
read-only access file under `.eve/`.
Keep the printed token for the benchmark shell.

To stop PostgreSQL, use the Compose command provided by your Docker installation:

```sh
docker compose -f apps/compute-platform/compose.yaml down
# or
docker-compose -f apps/compute-platform/compose.yaml down
```

Use `down -v` only when the local compute database should be deleted.

## Validate A2

```sh
pnpm --filter eve test:unit -- src/compute
pnpm compute:test:scenario
pnpm --filter @eve-internal/compute-platform typecheck
```

In another shell, export the same `EVE_COMPUTE_TOKEN` and run
`pnpm compute:benchmark`. The benchmark reports durable HTTP admission latency.
It does not include scheduling or invocation latency, which begin in A3.
