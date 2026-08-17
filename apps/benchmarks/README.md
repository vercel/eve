# eve benchmarks

This private workspace measures how coding agents create and modify eve projects. It uses
`@vercel/agent-eval`, Vercel Sandbox, and deterministic Vitest graders. These benchmarks do not
run in CI or as part of `pnpm test`.

## Run

The default subject is the current working tree, including uncommitted and untracked files that
Git does not ignore:

```sh
pnpm benchmark author-000-imessage
pnpm benchmark
pnpm benchmark author-000-imessage --runs 3
pnpm benchmark author-000-imessage --treatment baseline
pnpm benchmark author-000-imessage --dry
pnpm benchmark author-000-imessage --verbose
```

Use `--base` to compare a local Git revision with the working tree:

```sh
pnpm benchmark author-000-imessage --base origin/main --runs 3
```

Pass `--head` to compare two local revisions instead:

```sh
pnpm benchmark author-000-imessage \
  --base origin/main \
  --head feature-branch \
  --runs 3
```

The runner archives each subject locally and uploads it to the sandbox. Revisions and local-only
commits do not need to be pushed. Dependency downloads are cached by lockfile, so source-only
changes reuse the prepared pnpm store. For one eval and one run, `--verbose` streams setup
phases, assistant text, tool calls, grading, and build progress.

Local runs use the `guided` treatment by default, which keeps the `AGENTS.md` and aliases generated
by `eve init`. Pass `--treatment baseline` to remove those files before the coding agent starts.

Results are written under `apps/benchmarks/results/`. Each run includes the transcript,
grader output, summary, and copied project files. Vercel Sandbox and AI Gateway credentials are
required.

## Publish canonical results

Canonical publication compares the `baseline` and `guided` treatments with the same eve revision,
model, harness, cases, and graders. It requires a clean working tree and defaults to `origin/main`:

```sh
pnpm benchmark:publish --dry
pnpm benchmark:publish
pnpm benchmark:publish --revision <commit>
```

Pass `--allow-dirty` only for a local, noncanonical run. It bypasses the clean-tree check, so its
results cannot be reproduced from committed source and should not be committed as published data.

Each cell runs three times. Completed cells are memoized by `@vercel/agent-eval`; pass `--force` only
when every cell should run again. A successful run writes aggregate results to
`apps/docs/lib/evals/benchmark-results.json`. The public file contains outcomes and timing, not
transcripts, generated files, command logs, or synthetic world events.

Changed and newly added cases export as unavailable until they run. The exporter does not carry an
older measurement forward as current.

## Add a case

Create the next `evals/author-NNN-*` directory with:

- `CASE.ts` for the starting point, setup, and user interaction
- `EVAL.ts` for deterministic assertions
- any case-specific support files

The runner generates the `PROMPT.md` and `package.json` files required by agent-eval. A one-turn
case can be as small as:

```ts
export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send("Add a weather tool to this agent.");
  },
});
```

Use `simpleProject` for the selected subject's `eve init` output and `emptyProject` for an empty
directory with the subject CLI installed. Put reusable setup under `lib/setups/`. Prefer source
and event assertions over an LLM judge.
