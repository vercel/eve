# Dynamic schedules fixture

Exercises provider-backed `defineScheduleCollection(...)` authoring and its automatically generated management tools.

## In-memory development

```sh
pnpm --filter dynamic-schedules dev
```

`vercelScheduleProvider()` uses process-local storage under ordinary `eve dev`. Local schedules last only for the current process.

## Real Vercel Schedules control plane

Link the fixture to a schedules-enabled production project:

```sh
vercel link \
  --cwd apps/fixtures/dynamic-schedules \
  --team <team-slug> \
  --project <project-name>
```

Create a project-scoped personal bearer token and copy the plaintext value printed once by the CLI:

```sh
vercel tokens add "dynamic schedules local test" \
  --project <project-id> \
  --scope <team-slug>
```

Store it as `VERCEL_TOKEN` in the ignored `apps/fixtures/dynamic-schedules/.env.local`, or export it from the shell without placing the secret on the command line:

```sh
read -s VERCEL_TOKEN
export VERCEL_TOKEN
```

Then run:

```sh
pnpm --filter dynamic-schedules dev:vercel
```

`dev:vercel` prefers an exported `VERCEL_TOKEN`, otherwise loads it from the fixture's `.env.local`. It reads the project ID from `.vercel/project.json`, passes both values to the fixture's test-only provider configuration, and starts `eve dev`. It does not print the token. This mutates schedules in the linked production Vercel project. Do not add the token or the fixture's `EVE_TEST_ONLY_*` variables to shared project environment configuration.

You can test create, list, read, update, enable, disable, invoke, and delete through the generated tools. Vercel accepts invoke asynchronously; occurrences target the project's production queue and do not execute `collection.run` locally. End-to-end execution requires the generated production queue consumer, which is not implemented yet.

Registering `agent/schedules/collection.ts` contributes:

- `schedule__collection__create`
- `schedule__collection__list`
- `schedule__collection__read`
- `schedule__collection__update`
- `schedule__collection__enable`
- `schedule__collection__disable`
- `schedule__collection__delete`
- `schedule__collection__invoke` (enabled explicitly by this fixture)
