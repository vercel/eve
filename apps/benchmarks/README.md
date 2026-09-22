# eve benchmarks

This private workspace measures how coding agents create and modify eve projects. It uses
`@vercel/agent-eval`, Vercel Sandbox, and deterministic Vitest graders. These benchmarks do not
run in CI or as part of `pnpm test`.

## Run

The default subject is the current `main` canary. The runner resolves that moving alias once to its
immutable commit URL, then every model, treatment, and repetition uses that same artifact:

```sh
pnpm benchmark author-001-weather-tool
pnpm benchmark
pnpm benchmark author-001-weather-tool --runs 3
pnpm benchmark author-001-weather-tool --model kimi-k3
pnpm benchmark author-001-weather-tool --treatment baseline
pnpm benchmark author-001-weather-tool --dry
pnpm benchmark author-001-weather-tool --verbose
pnpm benchmark author-001-weather-tool --keep-failures
pnpm benchmark author-001-weather-tool --canary main
```

`--keep-failures` keeps a run the runner judged an infrastructure failure — a stalled turn, a
sandbox error — as the final result instead of discarding it. Use it while iterating on the
harness, when the failure itself is what you want to read.

`--canary <ref>` selects another published canary ref. The runner rejects refs without a package
artifact before it starts an eval. Local working trees, unpublished commits, and revision comparisons
are not supported by the native runner.

The runner uses agent-eval's native Gateway harnesses: OpenCode for other providers, Claude Code
for Anthropic models, and Codex for OpenAI models. Each attempt starts an isolated Vercel Sandbox,
then scaffolds the selected immutable canary with `npx` before the coding agent starts.

Local runs use the `guided` treatment by default, which keeps the `AGENTS.md` and aliases generated
by `eve init`. Pass `--treatment baseline` to remove those files before the coding agent starts.

Results are written under `apps/benchmarks/results/`. Each run includes the native transcript,
grader output, summary, copied project files, and validation output. Vercel Sandbox and AI Gateway
credentials are required.

## Publish canonical results

Canonical publication compares the `baseline` and `guided` treatments with the same immutable eve
canary, model, harness, cases, and graders. The configured harness reflects the provider: OpenCode
for other providers, Claude Code for Anthropic, and Codex for OpenAI. Publication requires a clean
working tree and defaults to `origin/main`:

```sh
pnpm benchmark:publish --dry
pnpm benchmark:publish
pnpm benchmark:publish --revision <commit>
pnpm benchmark:publish --models kimi-k3,gpt-5-6-sol
```

Pass `--allow-dirty` only for a local, noncanonical run. It bypasses the clean-tree check, so its
results cannot be reproduced from committed source and should not be committed as published data.

Without `--models`, publication covers the complete configured model matrix. Use `--models` to
publish or refresh selected model rows. The published suite currently includes weather-tool,
new-project, OpenAPI connection, packaged skill, conditional approval, custom channel, and digest
schedule cases. The iMessage case remains available for local runs but is excluded from the
published matrix. Each
cell runs three times. Completed cells are memoized by `@vercel/agent-eval`; pass `--force` only
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

Use `simpleProject` for the selected canary's `eve init` output and `emptyProject` for a project
the coding agent creates. Put reusable setup under `lib/setups/`. Native runs support one-turn
cases; the iMessage case remains local-only. Prefer source assertions over an LLM judge.
