# e2e

End-to-end coverage is fixture-owned `eve eval` runs. The suite only runs
fixture eval files from the fixture directory.

## Local

Run evals from the fixture directory:

```sh
cd e2e/fixtures/agent-basic-runtime
pnpm exec eve eval --strict
```

Every retained e2e eval is deterministic and self-contained. Coverage that
needs external services, injected env, or provider credentials is intentionally
not part of this suite.

Each retained fixture package also exposes the same command as:

```sh
pnpm --filter agent-basic-runtime test:e2e
```

The root convenience command runs every fixture package with a `test:e2e`
script:

```sh
pnpm test:e2e
```

## Vercel

Vercel e2e uses the same fixture evals against immutable preview deployment
URLs. All fixture deployments link to the same Vercel project id; isolation
comes from the deployment URL returned by `vc deploy --prebuilt`.

One-time project setup:

- Configure the shared Vercel project for Node.js 24.
- Provide the model-provider credentials the fixtures need (the agents and
  judges run against `openai/gpt-5.5`) in the project's Preview environment.
- Provide `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` in CI.

Run a fixture against Vercel from its directory:

```sh
vc link --yes --project "$VERCEL_PROJECT_ID"
vc env pull --yes --environment=preview
VERCEL=1 VERCEL_ENV=preview VERCEL_TARGET_ENV=preview \
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID" \
  VERCEL_DEPLOYMENT_ID="dpl_eve_e2e_manual" \
  pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL"
```

Do not set `VERCEL_TEAM_ID` at build: sandbox template keys must derive
identically at build and runtime, and Vercel has no team variable at runtime.

Both local and deployed evals run the fixture agents and judges against real
models (`openai/gpt-5.5`), so the environment must provide the corresponding
model-provider credentials.

## Fixtures

E2E fixtures live under `e2e/fixtures/*`. Fixture discovery also accepts
`apps/fixtures/*` apps with an `evals/` directory, but shared development apps
should stay out of the e2e matrix unless they intentionally own evals.

When adding e2e coverage:

- Put the eval in the fixture app's `evals/` directory.
- Keep it runnable with only `eve eval --strict`.
- Keep it deterministic: no external service startup or injected env
  requirements (beyond model-provider credentials).
- If the behavior cannot fit that shape yet, leave it out and rebuild it later
  as a first-class eval story.

## CI

`.github/workflows/e2e-local.yml` builds the eve package once per matrix leg,
then runs one fixture directory:

```sh
pnpm --filter eve run build
cd "$FIXTURE_DIR"
pnpm exec eve eval --strict --junit "$JUNIT_PATH"
```

Always build with the full `build` script (not `build:js`); only the full
build stamps the package version into `dist`.

`.github/workflows/e2e-vercel.yml` links each fixture directory to the shared
Vercel project id, builds Vercel output locally, deploys that output, and runs:

```sh
pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL" --junit "$JUNIT_PATH"
```

TUI smoke scripts are not e2e. They live under
`packages/eve/test/tui-client` and run through `pnpm test:tui`.
