# eve authoring evals

This private workspace measures how coding agents author and modify eve projects. It uses
[`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval) for coding-agent execution,
Vercel Sandbox or local Docker isolation, hidden Vitest graders, transcripts, repeated runs,
model matrices, and result reporting.

These evals are separate from `e2e/`. Runtime e2e suites exercise an already-authored agent
over HTTP; authoring evals give a coding agent a disposable project and grade the resulting
files, commands, validation, and any synthetic world events.

## Cases and treatments

Each directory under `evals/` is a standard agent-eval fixture:

- `PROMPT.md` describes a realistic outcome without naming its implementation.
- `EVAL.ts` contains hidden deterministic assertions.
- the remaining files are the starter project visible to the coding agent.

Experiment files under `experiments/` define treatments independently from cases. The
initial pair compares an unprompted baseline with an `AGENTS.md` treatment that directs the
agent to eve's version-matched installed documentation.

The initial iMessage case keeps real eve registry discovery, `eve add`, the registry setup
protocol, package installation, and project validation. Only the external provider is
synthetic. A fixture-owned setup package implements a deterministic authorization → user
input → project creation → phone registration decision tree and records events under
`__authoring_eval__/world-events.jsonl`. This tests an agent's setup decisions without
coupling the authoring suite to Photon or live external services.

Until agent-eval supports controlled follow-up turns, the phone number is included in the
initial prompt. The hidden grader still verifies that the agent passes that value through the
structured non-interactive setup protocol.

## Subject package

By default, the runner builds and packs eve from the current checkout's exact `HEAD`. Set both
variables below to evaluate a reachable branch or SHA from another checkout:

```sh
EVE_BENCHMARK_REPOSITORY=https://github.com/<owner>/eve.git \
EVE_BENCHMARK_REVISION=<branch-or-SHA> \
  pnpm benchmark:authoring author-000-imessage
```

Remote revisions are resolved to a commit SHA before checkout. The built tarball is cached at
`.eve/authoring-benchmarks/packages/<sha>/eve.tgz`, so repeated runs use exactly the same eve
package without relying on a published version or a mutable monorepo path. Remove that file to
force a package rebuild.

## Run

```sh
pnpm benchmark:authoring author-000-imessage
pnpm benchmark:authoring --all
pnpm benchmark:authoring --dry
pnpm benchmark:authoring author-000-imessage --force
```

The command runs both `baseline` and `agents-md` treatments. Agent-eval writes transcripts,
validation output, token usage, and summaries under `apps/authoring-benchmarks/results/`.
Use its playground command to inspect or compare results.

`@vercel/agent-eval` chooses Vercel Sandbox when credentials are available and can otherwise
use local Docker. The configured coding agent uses Vercel AI Gateway, so an applicable Gateway
credential is required.

## Adding a case

Copy an existing fixture, give it the next `author-NNN-*` name, then edit its prompt, hidden
grader, and starter project. Prefer final source and deterministic event assertions over an
LLM judge. Add a synthetic command or API world only when the task genuinely needs external
state, and mock the external boundary rather than eve itself.
