---
issue: TBD
status: proposed
last_updated: "2026-11-02"
---

# eve-code performance and surface reduction

## Summary

`eve/extensions/code` (eve-code) should contain only general coding behavior,
and every byte it sends to the model should earn its place on a coding
benchmark. Today it carries single-consumer code, a subagent no benchmark has
used, and a prompt written for a chat product.

What the evidence shows:

- **eve-code is behind on coding.** On deepswe-lean, the only coding set in
  CI (12 real-repo tasks), the fresh `main` baseline (run 41504242132, Sonnet
  5.5, 3 attempts, eve-code web tools off) resolved 20/36 for eve-code, 29/36
  for opencode, and 25/36 for pi. eve-code trails opencode by 25% (95% CI −42%
  to −11%). Earlier runs, with web tools on, had eve-code and pi tied at 50/72.
  - eve-code stops sooner than opencode: a median of 19.5 model steps, against
    26 for opencode and 17.5 for pi.
  - swe-lean is not a coding benchmark. It is 4 terminal-bench tasks (eve-code
    94/100, opencode 92/100, pi 89/100) plus 3 MCP data tasks (eve-code 72/75,
    pi 56/75).
  - In the earlier runs, only 4 of 12 tasks separated the harnesses (dateutil,
    prometheus, sqlite-utils, tengo). 7 were solved every time by everyone, and
    2 almost never by anyone.
- **The model ignores eve-code's tools.** In 108 earlier deepswe-lean trials on
  `anthropic/claude-sonnet-5.5`:
  - `apply_patch` was called twice, `code__grep` 9 times, and `code__worker`
    never, even though the worker was offered.
  - Nearly all reads and edits went through `bash`. The model also called
    `write_file` 9 times, to create new files.
  - pi looks the same: zero calls to its `edit` or `read` tools.
- **Failures are untested edge cases, not tool failures.** Failing attempts ran
  tests but never tested the edge case the task described. Examples: copying
  `click.Path(exists=True)` into a command that must accept a new file, and
  inventing a tie-break order. pi fails the same hidden tests.
- **Fixed prompt overhead is over 2x pi's.** In the baseline, the first step
  is about 7K input tokens including the task, against 3K for pi and 11K for
  opencode. eve core alone (default tools, Tasks section, skills section) is
  about 3K of that, so getting to pi's level needs more than eve-code changes.
  - pi now runs through `anthropic-messages` with prompt caching, so cost
    comparisons are like for like (non-zero cache reads in run 41504111932).
  - eve-code has the fastest median deepswe-lean latency (3m38s).
- **The read-only worker does not fit its job.**
  - Its only tools are `glob`, `grep`, and `read_file`
    (`test/scenario/worker-manifest.test.ts:73`). It cannot run `git diff`,
    read another ref, or run tests, unless the parent pastes the diff in.
  - It ignores the root model and calls `gpt-5.6-terra-fast` at `xhigh`.
  - The isolation also protects little. In the template's PR turns, the root
    agent already has the untrusted diff in context, alongside credentialed
    tools.

The plan has four parts: fix what the benchmark can detect, remove
single-consumer and unused API surface before 1.0.0, rewrite the prompt around
verification, then improve the tools and context. Each behavior change ships
as a paired variant and lands only if it passes a non-inferiority check.

## Goals

- deepswe-lean resolve rate non-inferior to pi and opencode on both
  `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`. The margin is set in
  Phase 0.
- eve-code's own share of the first-step input under 1.5K tokens. Core's share
  is tracked separately.
- No instruction names a tool the agent lacks, or assumes a channel the session
  is not on.
- No latency regression.

## Non-goals

- Changing Vercel credential brokering (the Connect hook, `authenticateVercel`,
  `vc` wrapper).
- Moving the `gh` wrappers out of `installCodeTooling`. eve-git's `gh` tool
  runs only the binaries `installCodeTooling` installs
  (`eve-git/extension/lib/tooling.ts:1-10`), and both sandbox entry points are
  stable. That belongs in a separate API proposal (`installGitTooling` in
  eve-git, with the eve-code path deprecated).
- Removing or deferring core default tools (`web_search`, `web_fetch`,
  `write_file`). An extension cannot remove root tools, and provider tools such
  as `webSearch()` reject `deferred`.
- Task-specific prompt hints.

## Observable changes

### Removed before 1.0.0

- **`worker` option and `code__worker` subagent.** `code({ worker })` fails
  config validation with a migration hint, not the generic unrecognized-key
  error: "eve-code no longer ships a worker subagent; delegate with the core
  `agent` tool and remove the `worker` option."
- **`eve/internal/code/prwatch`.** The internal export, and
  `lib/prwatch*.ts`, are removed.
- **`code__lookup-agent-run` skill.** A Vercel ops skill that needs access the
  extension does not provide.
- **Dead code.** `lib/repository-root.ts` is unused.

### Changed

- **`code__review` skill.** It becomes tool-neutral: "When you can start a
  fresh-context agent, give it a self-contained audit brief that names the
  repository, the ref or diff, and an instruction not to edit; otherwise audit
  in this session." The audit standards stay.
- **Extension instructions.** Phase 1 removes only the text that names the
  worker. Phase 2 rewrites the rest.
- **`code__investigate` skill (Phase 2).** It absorbs the "Issues and bugs" and
  "Analysis and design" sections that `instructions.md` currently sends on every
  step.

### Added later, gated on measurement

- **`code__edit` tool.** Input: `path`, plus `edits: [{ oldText, newText }]`.
  Each `oldText` must match a unique, non-overlapping region of the original
  file, after an exact match then a normalized fallback (NFKC, smart quotes,
  trailing whitespace). A miss returns the closest lines. On success it returns
  the same diagnostics as `apply_patch`, and it applies the same
  generated-file guard.
- **Environment context.** Phase 3.

## Phase 0: Measurement

Most of this is eve-bench work, tracked in an eve-bench issue. The eve side:

1. Run deepswe-lean weekly on `main`, with `openai/gpt-6.1-sol` beside
   `anthropic/claude-sonnet-5.5`, one job per family (#5806). Each job runs the
   whole dataset at 3 attempts, because eve-bench compares only whole-dataset
   results with matching attempts.
2. Grow the coding set with DeepSWE tasks (113 available) chosen because they
   separate harnesses on both models. terminal-bench does not exercise
   repository edits.
3. Choose a non-inferiority margin, and state the minimum effect the expanded
   set can detect. eve-bench resamples by task (`README.md:159`), so more tasks
   help and more attempts barely do.
4. In eve-bench:
   - Disable `web_search` and `web_fetch` for eve-code. It found the upstream
     PR in 6 sql-formatter trials.
   - Turn on prompt caching for pi.
   - Report first-step tokens, steps, and tool calls by name.

   Done in vercel-labs/eve-bench#103.

5. Make variants git refs. The extension is compiled into eve, and its
   instructions cannot be overridden, so each variant needs its own build.
6. Define the benchmark consumer contract. `packages/eve-code/agent/` owns the
   instructions and extension mount. eve-bench injects only instrumentation,
   task connections, and the sandbox. Drop the `E0_MODEL` default, then
   re-baseline, since changing the consumer makes stored baselines
   incomparable.

Exit criterion: a baseline of current eve-code, opencode, and pi on both
models, with the margin and detectable effect stated. The Sonnet baseline
exists (run 41504242132). The `gpt-6.1-sol` baseline first runs after #5806
merges.

## Phase 1: API removals (PR 1, before 1.0.0)

This PR carries only the removals and the `review` change listed under
Observable changes. It edits `instructions.md` only to drop text that names the
worker, so measured behavior changes no more than removing an unused tool. It
does not wait for Phase 0. Implemented in #5800.

- **Consumer migration.** The single consumer imports
  `eve/internal/code/prwatch` and loads `code__lookup-agent-run`. It vendors
  `lib/prwatch*.ts` and the skill before it bumps to the RC that contains the
  removal.
- **Template.** `apps/templates/eve-coding-agent-template` disables `agent` so
  delegation goes to `code__worker` (`agent/tools/agent.ts`,
  `instructions.md:16`). It pins a released eve, so update it after the RC
  that contains the removal:
  - delete `agent/tools/agent.ts`, re-enabling the core `agent` tool;
  - point the delegation line at `agent`, with a no-edit brief for read-only
    slices;
  - update the Delegation bullet in `README.md:31`, which names `code__worker`
    and says `agent` is disabled.
- **Tests:**
  - Remove `worker-manifest`, the worker case in `grep-search.test.ts`,
    `prwatch-*`, and the `validateRepositoryRoot` case.
  - Keep `code-query-worker` (renamed `diagnostics-worker`): it covers the
    TypeScript diagnostics worker that `apply_patch` still runs. Keep the
    workspace-root cases from `repository-root.test.ts`: they cover shipped
    workspace-boundary checks.
  - Add a `worker` rejection case to `extension-config`.
  - Replace the `worker`-based fixture in
    `packages/eve/src/compiler/mounted-extension.integration.test.ts:236-268`.
    It covers per-mount config isolation, so give it another config field
    rather than deleting it.
- **Docs:**
  - `docs/code-extension.mdx` (worker option, delegation text);
  - `docs/guides/dev-tui.md`;
  - the package README and `AGENTS.md`;
  - a 1.0 upgrade note.
- **Package:** remove the `./internal/code/prwatch` export from
  `packages/eve/package.json`.
- **Changeset:** `major`, following the pre-mode precedent in
  `.changeset/pre/eve-1-0.md`.

## Phase 2: Prompt rewrite

Replace `extension/instructions.md` in two stacked variants, so the effect can
be attributed. Each merges only when deepswe-lean shows it non-inferior to its
base. The PRs hold the final text:

- **2a, removals only (#5805).** 4,942 to 1,636 characters. It removes:
  - the chat-product text and consumer writing policy;
  - the duplicated parallelism lines and the nonexistent `todo` tool;
  - the Minds text;
  - the `apply_patch` and `grep` directives, which the tool descriptions
    already carry.

  It moves "Issues and bugs" and "Analysis and design" into `code__investigate`.
  It keeps the safety rules, the AGENTS.md instruction, and a tool-neutral line
  to edit with the editing tool rather than the shell, so GPT runs keep an
  editing directive.

- **2b, 2a plus a verification block (#5807).** 1,636 to 2,455 characters.
  When the agent changed code, it works out each requirement and its edge
  cases, checks each one by running code, keeps existing tests intact, states
  how it read an ambiguous request, and reports what it checked and what it
  could not check.

Neither variant carries identity or interaction policy, which belong to the
consumer: the benchmark consumer says "finish without asking", and the template
says "ask the one question you need answered". When the template upgrades, it
restates the consumer policies 2a removes.

The verification block came from 4 tasks, so judge 2b on DeepSWE tasks outside
the current deepswe-lean set. 2b may add steps, which is acceptable: opencode
takes more steps than eve-code and resolves more.

## Phase 3: Tools and context

1. **Edit tool per model.** Add `code__edit` (see Observable changes) and
   decide the selection semantics before building it:
   - **Rule:** by provider family, `openai/*` gets `apply_patch` and everyone
     else gets `edit`. No model-name heuristics.
   - **Overrides:** `apply_patch` stays a static, exported tool, and the
     documented `agent/tools/code__apply_patch.ts` override
     (`docs/code-extension.mdx:157-170`) must keep working. Today's primitives
     cannot express the selection. A dynamic tool replaces a same-named
     static one (`execution/catalog/step-catalog.ts:275`), so a dynamic
     `code__apply_patch` would replace the consumer's override. `disableTool()`
     is a static sentinel, and a dynamic resolver returns only tools or `null`
     (`tools/dynamic.ts:17`), so nothing can hide a static tool per model.
     Selection needs a core primitive for model-conditional tool availability
     that keeps consumer overrides in charge, proposed as its own change.
   - **Model switch mid-session:** history may hold calls to a tool that is no
     longer offered. Specify that behavior, and test it in a scenario test.

   Adoption may stay low on Claude, so gate on resolve rate and on edit
   failures in real repositories.

2. **Cost of `apply_patch` checks.** Each patch runs 3-6 sandbox commands, and
   type-checks TypeScript files twice. Measure on the GPT row, and merge the
   checks into one `sandbox.run` if they add more than about 200 ms per edit.
3. **Stop mounting `code__grep`.** It is core `grep` under another name (about
   1.6K characters of schema). Models use `rg`, and `code__grep` was called 9
   times in 108 trials. Keep the `grep` export from
   `eve/extensions/code/tools`, which is stable.
4. **Environment context.**
   - Inject cwd, date, platform, git branch, and a capped root `AGENTS.md`
     (about 4KB, using `lib/guidelines.ts`) through dynamic instructions.
   - Collect only when a sandbox already exists, so chat-only turns never
     start one.
   - Refresh per turn, so repositories cloned mid-session are picked up. Skip
     dirty state, which goes stale.
   - Once this lands, drop the root `AGENTS.md` line from the prompt, but keep
     the nested-file instruction.
   - This depends on giving dynamic instructions sandbox or state access,
     which is a separate PR.
   - deepswe-lean repositories may not have an AGENTS.md, so judge this on
     real-repository use as well.
5. **History growth.** History grows from about 11K to about 65K tokens per
   step over a deepswe-lean trial, and bash output volume equals pi's. Step
   count is not the lever: in the baseline, eve-code takes fewer steps than
   opencode. Reduce per-step input instead, and use the Phase 0 step metrics
   to see what 2b adds.
6. **Core Tasks section.** About 1.3K characters on every step while the
   `agent` tool is present. If Phase 0 shows it matters, propose a shorter
   version in core, as its own change.

## Phase 4: Latency

eve-code has the fastest median on deepswe-lean (3m38s). The remaining fixed
cost is about 2.6s per trial outside model and tool time: start to healthy is
a median 1.1s, and start to first event is 1.5s. Break down what is left
before attributing it to eve, and track eve's share under
[turn performance](./turn-performance.md). Less per-step input is the main
lever. Phase 2b may add steps, so check it against the no-regression goal.

## Sequencing

| Step | Repo      | Content                                                | Depends on                    | PR                  |
| ---- | --------- | ------------------------------------------------------ | ----------------------------- | ------------------- |
| 1    | eve       | Phase 1 removals, `review` skill change, docs, tests   | Nothing. Before 1.0.0         | #5800               |
| 2    | consumer  | Vendor the prwatch helpers and `lookup-agent-run`      | Before bumping to the RC of 1 | –                   |
| 3    | eve       | Template delegation and README update                  | The RC release containing 1   | –                   |
| 4    | eve-bench | Web off for eve-code, pi caching, overhead metrics     | –                             | eve-bench#103, done |
| 5    | eve-bench | Variants as git refs, consumer contract                | –                             | –                   |
| 6    | eve       | Two-family benchmark matrix, weekly deepswe-lean       | 4                             | #5806               |
| 7    | eve       | Task expansion, margin, re-baseline on both families   | 5, 6                          | –                   |
| 8    | eve       | Prompt variant 2a                                      | 1, 6                          | #5805               |
| 9    | eve       | Prompt variant 2b                                      | 7, 8                          | #5807               |
| 10   | eve       | Model-conditional tool availability (core)             | –                             | –                   |
| 11   | eve       | `code__edit` and selection, stop mounting `code__grep` | 9, 10                         | –                   |
| 12   | eve       | Dynamic-instructions sandbox or state access (core)    | –                             | –                   |
| 13   | eve       | Environment context                                    | 9, 12                         | –                   |

## Risks

- **1.0.0 timing.** PR 1 breaks a stable entry point and must merge before
  1.0.0.
- **Detectability.** If the expanded task set still cannot detect a useful
  effect, prompt changes are judged on step count and token metrics. Their
  correctness claims stay unproven.
- **Model family drift.** A change that helps one family can hurt the other.
  Every gate runs on both models.

## Evidence

- deepswe-lean baseline on `main`, run 41504242132: eve-code at `e65f42b`,
  Sonnet 5.5, reasoning `high`, 3 attempts, eve-code web tools off.
- pi prompt caching through `anthropic-messages`: run 41504111932.
- Earlier deepswe-lean runs 36917038074, 36775772040, and 36661642270 (Sonnet 5.5,
  reasoning `high`).
- swe-lean runs 41357706039, 40926137987, 40787734654, 40730672526, and
  40124518396.
- The current-RC first call, from run 41357706039: 8,994 characters of
  instructions and 11,392 characters of tool schemas.
- opencode v2 core at `805a42f`:
  - default prompt `packages/core/src/session/runner/prompt/system.txt`;
  - per-model edit swap `tool/plugin/patch.ts:288-301`.
- pi coding-agent 1.5.0 at `642e30b`:
  - prompt `src/core/system-prompt.ts`;
  - default tools `read`, `bash`, `edit`, `write`.
