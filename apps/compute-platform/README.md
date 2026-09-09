# Compute platform development setup

This directory boots the local infrastructure for milestone A1 only. It applies
the owned PostgreSQL schema and starts two supervisor processes that verify the
runtime database role and schema version. These worker-supervisor bootstraps do
not admit messages, schedule work, run transitions, execute application code, or
perform production migration or cutover.

## Start the local platform

Requirements:

- Node.js 24 and the repository's pinned pnpm version.
- Docker with either `docker compose` or `docker-compose`.

From the repository root:

```sh
pnpm install
pnpm compute:dev
```

The default PostgreSQL port is `55432`. Set `EVE_COMPUTE_POSTGRES_PORT` before
starting to use another port. Local-only credentials are declared in
[`compose.yaml`](./compose.yaml); the migrator, runtime, and inspector use
separate database roles.

To stop PostgreSQL, use the Compose command provided by your Docker installation:

```sh
docker compose -f apps/compute-platform/compose.yaml down
# or
docker-compose -f apps/compute-platform/compose.yaml down
```

Use `down -v` only when the local compute database should be deleted.

## Validate A1

```sh
pnpm --filter eve test:unit -- src/compute
pnpm compute:test:scenario
pnpm --filter @eve-internal/compute-platform typecheck
```

After `pnpm compute:dev` is running, `pnpm compute:benchmark` reports a small
storage round-trip baseline. It is not the admission-to-execution benchmark
required by later milestones.
