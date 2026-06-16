# Contributing to eve

Thanks for your interest in contributing! This guide covers everything you need to get the repo running locally and land a change.

## Prerequisites

- **Node.js 24+** — see [`.nvmrc`](./.nvmrc) (`nvm use` or `fnm use`)
- **pnpm** — the version pinned in [`package.json`](./package.json) (`corepack enable` handles this automatically)

## Getting started

```bash
git clone https://github.com/vercel/eve.git
cd eve
pnpm install
pnpm build
```

The repo is a pnpm workspace orchestrated with [Turborepo](https://turborepo.com):

- [`packages/eve`](./packages/eve) — the framework and `eve` CLI
- [`packages/eve-scaffold`](./packages/eve-scaffold) / [`packages/eve-catalog`](./packages/eve-catalog) — internal (unpublished) scaffolding libraries
- [`apps/fixtures`](./apps/fixtures) — shared agent fixtures used by e2e tests, TUI smoke tests, local dev, and bundle analysis
- [`apps/frameworks`](./apps/frameworks) — framework integration apps for Next.js, Nuxt, and SvelteKit
- [`apps/templates`](./apps/templates) — source apps for generated templates
- [`docs`](./docs) — the published documentation content
- [`e2e/`](./e2e) — fixture-owned `eve eval` end-to-end tests

## Development

```bash
pnpm dev
```

This runs the `eve` package build in watch mode alongside the [`apps/fixtures/weather-agent`](./apps/fixtures/weather-agent) fixture on an OS-assigned available localhost port. The fixture prints the selected URL at startup.

## Testing

```bash
pnpm test               # unit + integration
pnpm test:unit          # unit tests
pnpm test:integration   # integration tests
pnpm test:scenario      # scenario tests (requires pnpm build first)
pnpm test:e2e           # fixture-owned eve eval suites
pnpm test:tui           # TUI smoke scripts (not e2e)
```

E2E tests are fixture-owned evals. Run them from the fixture directory:

```bash
cd e2e/fixtures/agent-basic-runtime
pnpm exec eve eval --strict
```

The fixture agents and judges run against real models (`openai/gpt-5.5`), so
the environment must provide the corresponding model-provider credentials.

Vercel e2e builds that same fixture directory with `VERCEL=1`, deploys the
fixture's prebuilt Vercel output, and runs evals against the immutable
deployment URL. All fixture deployments link to the same Vercel project id; the
shared project's Preview env must provide those same model-provider
credentials.

Do not commit fixture trees under `packages/eve/test/fixtures/` — scenario app content is defined inline as `ScenarioAppDescriptor` objects under `packages/eve/src/internal/testing/scenario-apps/` (CI enforces this).

## Linting and formatting

```bash
pnpm lint          # oxlint (auto-fixes)
pnpm fmt           # oxfmt (also runs on staged files via the pre-commit hook)
pnpm typecheck     # TypeScript across the workspace
pnpm check:deps    # syncpack — dependency versions must stay in sync
pnpm guard:invariants  # mechanical code-invariant lints (run in CI)
pnpm docs:check    # docs frontmatter and nav validation
```

All of these run in CI, so running them locally before pushing saves a round trip.

## Documentation

User-facing docs live in [`docs/`](./docs) and are published with the `eve` npm package and rendered by the docs site in [`apps/docs`](./apps/docs). If your change alters public behavior, update the relevant doc in the same PR and run `pnpm docs:check`.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your change, including tests and docs where relevant.
3. If the change affects the published `eve` package, add a changeset:

   ```bash
   pnpm changeset
   ```

4. Make sure `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
5. Open the PR with a clear description of the problem and solution.

Releases are managed with [Changesets](https://github.com/changesets/changesets) by the maintainers.

## Reporting bugs and requesting features

Please use the [issue templates](https://github.com/vercel/eve/issues/new/choose). For security issues, **do not open a public issue** — follow [SECURITY.md](./SECURITY.md) instead.

## Code of conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
