# e2e

End-to-end coverage is fixture-owned `eve eval` runs. The suite only runs
fixture eval files from the fixture directory.

## Local

Run evals from the fixture directory:

```sh
cd e2e/fixtures/agent-basic-runtime
EVE_E2E_MODEL="openai/gpt-5.6-sol" pnpm exec eve eval --strict
```

Every retained e2e eval is deterministic and self-contained. Coverage that
needs external services or injected env is intentionally not part of this
suite. Most fixtures use the shared model-provider credentials; dedicated
runtime stress fixtures may use an authored deterministic model instead.

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
- Provide the model-provider credentials needed by `EVE_E2E_MODEL` in the
  project's Preview environment.
- Provide `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` in CI.

Run a fixture against Vercel from its directory:

```sh
vc link --yes --project "$VERCEL_PROJECT_ID"
vc env pull --yes --environment=preview
VERCEL=1 VERCEL_ENV=preview VERCEL_TARGET_ENV=preview \
  VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID" \
  pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview \
  --env "EVE_E2E_MODEL=$EVE_E2E_MODEL" | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL"
```

Do not set `VERCEL_TEAM_ID` at build: sandbox template keys must derive
identically at build and runtime, and Vercel has no team variable at runtime.

### Redeploy suite

`agent-tools-sandbox/evals/sandbox/redeploy.eval.ts` proves sandbox semantics
across deployment updates as they behave on preview targets: a parked session
keeps working (with its `/workspace` state intact) when messages route through
a new deployment, its turns stay pinned to the deployment that created it
(branch-less CLI preview deploys cannot resolve a "latest" deployment; see
`shouldRouteToLatestDeployment` in `execution/workflow-runtime.ts`), and new
sessions adopt the new deployment — a skill added by the redeploy loads there.
The pinned-turn assertion is a deliberate tripwire: it must be flipped when
turn dispatch gains preview latest-routing
(https://github.com/vercel/eve/issues/582).

The eval redeploys from inside its test body: it mutates the agent source,
runs `eve build` + `vc deploy`, and repoints a run-scoped Vercel alias at
each new deployment, polling `/eve/v1/info` until the alias serves it.
Because immutable deployment URLs never change what they serve, the eval
must run against the alias — the `e2e-vercel` workflow sets
`EVE_E2E_REDEPLOY_ALIAS`, aliases the deployment, and runs `--tag redeploy`
evals as a second `eve eval` invocation after the main suite. Without the
alias env (local matrix, plain `eve eval --strict`) the eval skips.

Most fixture agents and their configured judges use `EVE_E2E_MODEL`, defaulting
to `openai/gpt-5.6-sol` for local runs. CI sets it from the model matrix, so
adding a matrix entry runs every discovered fixture against that model.
`agent-prompt-cache` is the one fixture that authors a direct
`@ai-sdk/anthropic` model instance instead of a gateway model id: its eval
asserts the harness's Anthropic cache-breakpoint placement, which only runs on
that path. It uses the matrix model when it is an Anthropic model and otherwise
falls back to `anthropic/claude-opus-4.8`. The instance points at the AI
Gateway's Anthropic-compatible Messages endpoint so it uses the same
`AI_GATEWAY_API_KEY` credential as every other fixture.
`agent-workflow-stress` uses eve's `mockModel` fixture helper so its 100-turn
runs stay fast and deterministic. Its concurrent and sequential evals cover
high-volume session execution and repeated session resumption respectively.

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
then runs one fixture directory. Its matrix crosses every discovered fixture
with these model entries:

- `openai-sol` → `openai/gpt-5.6-sol`
- `anthropic-opus` → `anthropic/claude-opus-4.8`

The short name is the stable Actions check identifier; the full id selects the
provider model. Updating a model version does not rename required checks.
Each workflow also publishes one stable aggregate check, `e2e-local` or
`e2e-vercel`, which succeeds only when every fixture and model leg succeeds.
Require those two checks in the repository ruleset so newly added fixtures and
models become required automatically.

Each leg exports the selected id as `EVE_E2E_MODEL` before it runs:

```sh
pnpm --filter eve run build
cd "$FIXTURE_DIR"
EVE_E2E_MODEL="$MODEL" pnpm exec eve eval --strict --junit "$JUNIT_PATH"
```

Always build with the full `build` script (not `build:js`); only the full
build stamps the package version into `dist`.

`.github/workflows/e2e-vercel.yml` links each fixture directory to the shared
Vercel project id, builds Vercel output locally, deploys that output, and runs:

```sh
pnpm exec eve build
DEPLOYMENT_URL="$(vc deploy --prebuilt --yes --target=preview \
  --env "EVE_E2E_MODEL=$EVE_E2E_MODEL" | tail -n 1)"
npx eve eval --strict --url "$DEPLOYMENT_URL" --junit "$JUNIT_PATH"
```

TUI smoke scripts are not e2e. They live under
`packages/eve/test/tui-client` and run through `pnpm test:tui`.
