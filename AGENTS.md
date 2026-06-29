# AGENTS.md

Guidance for coding agents (and humans) working in this repository. For setup,
PR workflow, and release process, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## About eve

eve is a filesystem-first framework for durable backend AI agents. You author
an agent as a directory on disk — instructions, skills, tools, connections,
channels, subagents, and schedules are all files — and eve compiles and runs it.
See the [README](./README.md) for the full overview and
[`docs/`](./docs) for user-facing documentation.

Always style the framework name as `eve`, lowercase, in user-facing copy,
docs, prompts, comments, and headings.

## Repository layout

- `packages/eve` — the framework and `eve` CLI (the main package)
- `packages/eve-catalog` — internal, unpublished library
- `apps/fixtures` — shared agent fixtures used by e2e, TUI smoke tests, and local dev
- `apps/frameworks`, `apps/templates`, `apps/docs` — framework integrations, templates, docs site
- `docs` — published documentation content
- `e2e/` — fixture-owned `eve eval` end-to-end tests
- `research` — issue-backed implementation plans for proposed changes

## Git workflow

Commits must be cryptographically signed with a GitHub-verified key and include
the DCO `Signed-off-by` trailer. Use `git commit -s` for every commit, and if a
commit is missing the trailer, amend it with `git commit --amend -s --no-edit`
before pushing.

## Commands

```sh
pnpm install            # install workspace dependencies
pnpm build              # build all packages
pnpm dev                # watch-mode build + weather fixture on an available local port

pnpm typecheck          # TypeScript across the workspace
pnpm lint               # oxlint (auto-fixes)
pnpm fmt                # oxfmt
pnpm guard:invariants   # mechanical code-invariant checks (runs in CI)
pnpm docs:check         # docs frontmatter and nav validation

pnpm test               # unit + integration
pnpm test:unit          # unit tests (<3s)
pnpm test:integration   # integration tests (<10s)
pnpm test:scenario      # scenario tests (2–5 min; requires pnpm build first)
pnpm test:e2e           # fixture-owned eve eval suites (CI only)
pnpm test:tui           # TUI smoke scripts (not e2e)
```

We value fast local iteration whenever possible. Run `pnpm fmt`, `pnpm lint`,
and `pnpm typecheck` frequently to catch inexpensive failures early, and run
unit tests after material behavioral changes. Integration and scenario tests
are comparatively slow, so do not run them after every change; run the
narrowest relevant test when a change needs behavioral validation. Copy edits,
typo fixes, small code reorganizations, and similar non-behavioral changes can
proceed without local integration or scenario runs. CI is always the official
line of defense, and every required check must pass before merge.

## Coding principles

1. **Public APIs need docs and tests.** Exported functions, classes, and
   important public types get documentation comments and at least one test.

2. **Small modules over big helpers.** Favor composable primitives with narrow
   responsibilities. Split files that carry multiple concerns.

3. **Wrap third-party dependencies.** Do not expose third-party APIs as eve
   public APIs. Wrap them in eve-owned surfaces so internals can change freely.
   Add runtime `dependencies` only as a last resort: prefer vendoring code or
   generated artifacts into the repository and listing the source package under
   `devDependencies`. The `eve` package should aim to keep `nitro` as its only
   runtime dependency. This keeps eve installs as small as possible and avoids
   exposure to hijacked nested dependencies that are not pinned directly in the
   main lockfile.

4. **Pre-1.0: prefer breaking changes.** Favor correctness and simplicity over
   backwards compatibility. No legacy fallback logic.

5. **Derive names from file paths.** Connection names, tool names, and similar
   identifiers come from the filesystem path (e.g.
   `agent/connections/linear.ts` → `"linear"`). Do not add redundant `name`
   fields to definitions.

6. **Name definitions for the protocol they target.** Use
   `defineMcpClientConnection`, not `defineConnection`.

7. **All runtime functionality lives in the `eve` package.** Never rely on
   emitted or generated code for runtime behavior.

8. **Comment why, not what.** Default to no comment; well-named code is the
   documentation. Comment only what the code cannot say itself — a non-obvious
   why, an invariant, a surprising edge case. Public API docs (principle 1) are
   the exception.

Machine-checkable invariants are enforced by `pnpm guard:invariants`, which
runs in the CI lint job. If the guard fails, fix the violation rather than
editing the baseline — baselines may only shrink.

## Research plans

Research documents live in the top-level `research/` directory and require
`issue`, `status`, and `last_updated` frontmatter. Keep plans concise and focus
primarily on the proposed authoring API and externally observable semantics.
Include only the architecture needed to explain boundaries, data flow, and
invariants; avoid speculative implementation detail, repeated rationale, and
exhaustive task inventories. Use a compact diagram when it makes a lifecycle
or ownership relationship materially clearer.

## Testing

Tests belong in one of four tiers. Pick the tightest tier that can express the
assertion:

- **Unit** (`src/**/*.test.ts`): pure logic, colocated. No filesystem writes,
  subprocesses, or real network calls.
- **Integration** (`src/**/*.integration.test.ts`): multiple modules in memory.
- **Scenario** (`src/**/*.scenario.test.ts`, `test/scenarios/`): real
  subprocess, HTTP port, or bundler.
- **E2E** (`e2e/fixtures/*/evals/`, plus `apps/fixtures/weather-fixture/evals/`):
  fixture-owned `eve eval` suites that run only in CI.

**Running a single file or filtered test: always pass the tier config.** Only
the `vitest.<tier>.config.ts` files alias `#*` imports to `./src`; a bare
`vitest run <path>` resolves them to compiled `./dist` output, so you end up
testing stale builds. Use:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts <path-or-pattern>
# or vitest.integration.config.ts / vitest.scenario.config.ts for those tiers
```

Add `-t "<name>"` to filter by test name. If you touched anything under
`#compiled/*`, run `pnpm --filter eve build:compiled` first — the tier configs
do not rebuild it.

Do not commit fixture trees under `packages/eve/test/fixtures/` — scenario app
content is defined inline as `ScenarioAppDescriptor` objects (CI enforces this).

## End-to-end tests

Automated tests cover module-level behavior, but they don't prove a fixture
agent boots, accepts a request, and streams a response over HTTP. E2E suites
cannot run locally and must run in CI. When a change needs e2e coverage, add or
update the relevant fixture eval, then proceed to commit and push. Optionally
watch CI for the results and iterate on any failures.

Pick the fixture that exercises the surface you changed; if none does, add a
new eval under the matching fixture's `evals/` directory. E2E evals must be
deterministic and self-contained. Keep e2e free of external service startup
and injected env requirements (beyond model-provider credentials).

Do not set `VERCEL_TEAM_ID` at build: sandbox template keys must derive
identically at build and runtime, and Vercel has no team variable at runtime.

The shared Vercel project's Preview env must provide the model-provider
credentials the fixtures need. TUI smoke tests
live under `packages/eve/test/tui-client` and run with `pnpm test:tui`. See
[`e2e/README.md`](./e2e/README.md).

## Documentation

- `docs/**` is the published documentation. If your change alters
  public behavior, update the relevant doc in the same PR and run
  `pnpm docs:check`.
- Sidebar order lives in `docs/meta.json`.
- Keep markdown framework-agnostic — no MDX-only constructs unless the page is
  `.mdx`.

## Changesets

Every PR that touches the published `eve` package must include a
changeset (`pnpm changeset`). Because eve is pre-1.0, use `patch` in most
cases, including bug fixes and new features. Use `minor` only when the change
breaks a public API. Write the body for someone reading release notes — what
changed and what they'll see differently, in 1–2 sentences.

Docs-only, internal-tooling, and fixture changes do not need a changeset. When
in doubt, add one.
