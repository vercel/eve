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
- `seed/` contains benchmark support moved out of sight before the coding agent runs.

The setup hook creates the subject project with the selected package's real `eve init`, so each
case evaluates the scaffolded source, package policy, and coding-agent instructions from that
exact eve revision rather than a manually maintained approximation.

Experiment files under `experiments/` define treatments independently from cases. The
initial pair compares a baseline that removes the scaffolded coding-agent guidance with the
unaltered `eve init` project, including its version-matched `AGENTS.md` and `CLAUDE.md`.

The initial iMessage case keeps real eve registry discovery, `eve add`, the registry setup
protocol, package installation, and project validation. Only the external provider is
synthetic. A fixture-owned setup package implements a deterministic user input → project
creation → phone registration decision tree and records events under
`__authoring_eval__/world-events.jsonl`. This tests an agent's setup decisions without
coupling the authoring suite to Photon or live external services.

The iMessage case runs through a registered HarnessAgent-backed Claude Code adapter so the user simulator can
inspect each completed assistant turn and reply in the same native session. The initial prompt
omits the phone number; the simulator requires the agent to ask for it before responding. The
hidden grader verifies both the interaction transcript and the structured non-interactive setup
protocol.

The adapter also uses HarnessAgent's `bootstrapHash` and `onBootstrap` hooks to build one reusable
Vercel Sandbox snapshot per subject repository and revision. Each benchmark attempt starts from an
independent sandbox restored from that prepared project, then applies treatment-specific changes
in `onSession`.

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
