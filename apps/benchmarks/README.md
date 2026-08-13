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
commits do not need to be pushed. For one eval and one run, `--verbose` streams setup phases,
assistant text, tool calls, grading, and build progress.

Results are written under `apps/benchmarks/results/`. Each run includes the transcript,
grader output, summary, and copied project files. Vercel Sandbox and AI Gateway credentials are
required.

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
