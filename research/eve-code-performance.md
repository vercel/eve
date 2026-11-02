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

- **Coding results are at parity with pi.** On deepswe-lean, the only coding
  set in CI (12 real-repo tasks, last run 2026-10-01), eve-code and pi are
  tied at 50/72 pooled. opencode 2.0.20 led the newest run, 27/36 to 24/36.
  - swe-lean is not a coding benchmark. It is 4 terminal-bench tasks (eve-code
    94/100, opencode 92/100, pi 89/100) plus 3 MCP data tasks (eve-code 72/75,
    pi 56/75).
  - On deepswe-lean, only 4 of 12 tasks separate the harnesses (dateutil,
    prometheus, sqlite-utils, tengo). 7 are solved every time by everyone, and
    2 are almost never solved by anyone.
- **The model ignores eve-code's tools.** In 108 deepswe-lean trials on
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
- **Fixed prompt overhead is about 3x pi's.** On the current RC, the first
  call is 8.5-9.8K tokens including the task, against 2.6-3.7K for pi. eve
  core alone (default tools, Tasks section, skills section) is about 3K of
  that, so getting to pi's level needs more than eve-code changes.
  - Raw cost comparisons with pi are an adapter artifact: eve-bench sends pi
    through Chat Completions with zero cache reads.
  - eve-code's median deepswe-lean latency is already below pi's (245s vs
    261s).
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

1. Schedule deepswe-lean on `main`, sharded by task so each job fits the time
   limit (`resolve-benchmark-request.mjs:16-22` caps one job at 3 attempts).
   Add `openai/gpt-6.1-sol` beside `anthropic/claude-sonnet-5.5`.
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

   Implemented in vercel-labs/eve-bench#103.

5. Make variants git refs. The extension is compiled into eve, and its
   instructions cannot be overridden, so each variant needs its own build.
6. Define the benchmark consumer contract. `packages/eve-code/agent/` owns the
   instructions and extension mount. eve-bench injects only instrumentation,
   task connections, and the sandbox. Drop the `E0_MODEL` default, then
   re-baseline, since changing the consumer makes stored baselines
   incomparable.

Exit criterion: a baseline of current eve-code, opencode, and pi on both
models, with the margin and detectable effect stated.

## Phase 1: API removals (PR 1, before 1.0.0)

This PR carries only the removals and the `review` change listed under
Observable changes. It edits `instructions.md` only to drop text that names the
worker, so measured behavior changes no more than removing an unused tool. It
does not wait for Phase 0. Implemented in #5800.

- **Template.** `apps/templates/eve-coding-agent-template` disables `agent` so
  delegation goes to `code__worker` (`agent/tools/agent.ts`,
  `instructions.md:16`). It pins a released eve, so update it after the RC
  that contains the removal:
  - delete `agent/tools/agent.ts`, re-enabling the core `agent` tool;
  - point the delegation line at `agent`, with a no-edit brief for read-only
    slices.
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
  - the eve-git README;
  - a 1.0 upgrade note.
- **Package:** remove the `./internal/code/prwatch` export from
  `packages/eve/package.json`.
- **Changeset:** `major`, following the pre-mode precedent in
  `.changeset/pre/eve-1-0.md`.

## Phase 2: Prompt rewrite

Replace `extension/instructions.md` (about 6K characters) in two variants, so
the effect can be attributed:

- **2a, removals only.** Delete:
  - the chat-product text ("instant messaging app", "ask one question",
    "default to silence");
  - consumer writing policy;
  - the duplicated parallelism lines;
  - the reference to the nonexistent `todo` tool;
  - the Minds and delegation sections.

  Keep the safety rules and the AGENTS.md instruction.

- **2b, 2a plus a verification block.**

Draft of 2b. It omits identity and interaction policy, which belong to the
consumer: the benchmark consumer says "finish without asking", and the template
says "ask the one question you need answered".

```md
# Coding

- Match action to the request. Questions, reviews, and diagnoses get
  inspection and an answer, not edits. Change files only when asked to.
- Before editing in a checkout, read its root `AGENTS.md` (or `CLAUDE.md`), and
  the nearest nested one for the paths you touch. Follow the conventions of
  the surrounding code.
- Change generated files (lockfiles, build output) only by running their
  generator.
- Preserve changes you did not make. Do not run `git reset --hard`,
  `git checkout --`, or similar commands unless asked. Do not delete
  recursively on a home, repository, or workspace root, an unresolved
  variable, or a broad glob.
- Never print credentials, tokens, or `.env` contents.
- Read large files in sections.

# When you changed code

Before finishing:

1. Re-read the request, and work out each requirement and the edge cases it
   implies.
2. Check each one by running code: the relevant existing tests, plus a focused
   check for anything they do not cover. Do not weaken or delete existing
   tests to make them pass.
3. Where the request is ambiguous, choose the reading most consistent with its
   wording and the existing code and tests, and say which you chose.
4. Remove scratch scripts and files you created for checking.

Build large changes in steps and run them as you go.

# Reporting

Lead with the outcome. Name the files you changed and the checks you ran, with
their results.
```

The verification block came from 4 tasks, so judge 2b on DeepSWE tasks outside
the current deepswe-lean set. The "use the editing tool" line is not in the
draft: the current prompt says it more strongly and Claude still did not use
`apply_patch`. If it comes back, it is its own variant.

## Phase 3: Tools and context

1. **Edit tool per model.** Add `code__edit` (see Observable changes) and
   decide the selection semantics before building it:
   - **Rule:** by provider family, `openai/*` gets `apply_patch` and everyone
     else gets `edit`. No model-name heuristics.
   - **Overrides:** `apply_patch` stays a static, exported tool. The
     documented `agent/tools/code__apply_patch.ts` override
     (`docs/code-extension.mdx:157-170`) must keep working, and making it
     dynamic would silently lose to an override. Selection therefore cannot
     just turn `apply_patch` into a dynamic tool. One option is a dynamic
     `disableTool()` on the non-preferred tool, but verify how it interacts
     with consumer overrides and the mount prefix first.
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
   step over a deepswe-lean trial. Bash output volume equals pi's, so the
   lever is step count: eve-code took 87 more steps than pi in run
   36917038074. Use the Phase 0 step metrics to check whether 2b reduces it.
6. **Core Tasks section.** About 1.3K characters on every step while the
   `agent` tool is present. If Phase 0 shows it matters, propose a shorter
   version in core, as its own change.

## Phase 4: Latency

eve-code's median is already below pi's on deepswe-lean. The remaining fixed
cost is about 2.6s per trial outside model and tool time: start to healthy is
a median 1.1s, and start to first event is 1.5s. Break down what is left
before attributing it to eve, and track eve's share under
[turn performance](./turn-performance.md). Fewer steps (Phase 2) and less
per-step input are the main levers.

## Sequencing

| PR  | Repo      | Content                                                                        | Depends on                     |
| --- | --------- | ------------------------------------------------------------------------------ | ------------------------------ |
| 1   | eve       | Phase 1 removals, `review` skill change, docs, tests (#5800)                   | Nothing. Before 1.0.0          |
| 2   | eve       | Template delegation update                                                     | The RC release containing PR 1 |
| 3   | eve-bench | Web off for eve-code, pi caching, metrics, variants, consumer contract         | –                              |
| 4   | eve       | Scheduled sharded deepswe-lean, `gpt-6.1-sol` row, task expansion, re-baseline | 3                              |
| 5   | eve       | Prompt variants 2a and 2b                                                      | 4                              |
| 6   | eve       | `code__edit` and selection, stop mounting `code__grep`                         | 5                              |
| 7   | eve       | Dynamic-instructions sandbox or state access (core)                            | –                              |
| 8   | eve       | Environment context                                                            | 5, 7                           |

## Risks

- **1.0.0 timing.** PR 1 breaks a stable entry point and must merge before
  1.0.0.
- **Detectability.** If the expanded task set still cannot detect a useful
  effect, prompt changes are judged on step count and token metrics. Their
  correctness claims stay unproven.
- **Model family drift.** A change that helps one family can hurt the other.
  Every gate runs on both models.

## Evidence

- deepswe-lean runs 36917038074, 36775772040, and 36661642270 (Sonnet 5.5,
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
