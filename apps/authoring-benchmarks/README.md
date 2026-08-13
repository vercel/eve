# eve authoring evals

This private workspace measures how coding agents author and modify eve projects. It uses
[`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval) for coding-agent execution,
Vercel Sandbox isolation, hidden Vitest graders, transcripts, repeated runs, model matrices, and
result reporting.

These evals are separate from `e2e/`. Runtime e2e suites exercise an already-authored agent
over HTTP; authoring evals give a coding agent a disposable project and grade the resulting
files, commands, validation, and any synthetic world events.

## Cases

Each directory under `evals/` contains:

- `CASE.ts`, which selects a reusable starting point, adds optional setup, and defines the user interaction.
- `EVAL.ts`, which contains hidden deterministic assertions.
- Case-specific support files, when needed, which are installed during setup and kept out of sight from the coding agent.
- `PROMPT.md`, a compatibility stub used only by agent-eval to discover the fixture. Its contents are never sent to the coding agent.

A case starts from a shared primitive such as `simpleProject` (the selected revision's real
`eve init` output) or `emptyProject` (an empty directory with the subject CLI installed). This
lets cases reuse an exact starting point rather than maintain an approximation of generated
source, package policy, or coding-agent instructions.

The runner generates gitignored experiment files for each invocation. Every subject revision
uses the real authoring experience: the unaltered `eve init` project, including its
version-matched `AGENTS.md` and `CLAUDE.md`.

The HarnessAgent adapter owns only the shared authoring lifecycle: bootstrap the selected eve
revision, create an isolated session, capture commands and transcripts, and grade the result.
Each case's `interact` function owns every user turn, including the first, through a small
`send(prompt)` helper. One-turn cases call it once; multi-turn cases keep the conversation in
one place. Reusable setup objects can add bootstrap work, per-session work, ports, or environment
on top of the selected starting point.

The initial iMessage case keeps real eve registry discovery, `eve add`, the registry setup
protocol, package installation, and project validation. Only the external provider is
synthetic. Its reusable setup package implements a deterministic user input → project creation
→ phone registration decision tree and records events under
`__authoring_eval__/world-events.jsonl`. The iMessage setup owns this synthetic registry and
provider; the shared adapter has no Photon or iMessage knowledge.

The iMessage interaction omits the phone number from its first `send`, inspects the completed
assistant turn, requires the agent to ask for the number, and replies in the same native session.
The hidden grader verifies both the transcript and the structured non-interactive setup protocol.

HarnessAgent builds one reusable Vercel Sandbox snapshot for each subject revision, starting
point, and setup combination. Compatible cases and repeated runs share the prepared checkout,
eve build, project scaffold, and dependencies; each attempt runs in an independent fork.

## Subject revision

By default, the runner evaluates the current checkout's exact `HEAD` from its `origin` remote.
Push the commit first so the sandbox can fetch it. Set both variables below to evaluate a
reachable branch or SHA from another repository:

```sh
EVE_BENCHMARK_REPOSITORY=https://github.com/<owner>/eve.git \
EVE_BENCHMARK_REVISION=<branch-or-SHA> \
  pnpm benchmark:authoring author-000-imessage
```

Remote revisions are resolved to a commit SHA before the experiments start. HarnessAgent then
builds that exact checkout once in the case's reusable sandbox snapshot, without relying on
a published package or mutable branch reference.

## Run

```sh
pnpm benchmark:authoring author-000-imessage
pnpm benchmark:authoring --all
pnpm benchmark:authoring author-000-imessage --runs 3
pnpm benchmark:authoring author-000-imessage --dry
```

Normal runs always execute fresh samples; cached agent-eval results are not reused. These
benchmarks do not run in CI or as part of `pnpm test`.

To compare framework behavior before and after a change, hold the cases, guidance, model, and
grading fixed and select two reachable subject revisions:

```sh
pnpm benchmark:authoring author-000-imessage \
  --base origin/main \
  --head HEAD \
  --runs 3
```

This runs the `base` and `head` subjects with identical cases, guidance, model, and grading.
Agent-eval writes ignored local results under
`apps/authoring-benchmarks/results/<subject>/<timestamp>/<case>/`. Each case directory contains
`summary.json` and per-run result, transcript, grader output, and copied project files. Use
agent-eval's playground command to compare the two experiment columns.

The suite uses Vercel Sandbox and Vercel AI Gateway, so applicable credentials are required.

## Adding a case

Copy an existing fixture, give it the next `author-NNN-*` name, then edit `CASE.ts` and the
hidden grader. Select `simpleProject` or `emptyProject`, compose reusable setup when needed, and
put the complete user interaction in `interact`. There is no scenario registry to update.

Keep setup that is useful across cases under `lib/setups/`. Keep one-off setup next to the case
or inline in `CASE.ts`. A one-turn filesystem task can be as small as:

```ts
export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send("Add a weather tool to this agent.");
  },
});
```

Prefer final source and deterministic event assertions over an LLM judge. Add a synthetic
command or API world only when the task genuinely needs external state, and keep that world in
the case or a reusable setup rather than the shared HarnessAgent adapter.
