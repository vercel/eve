---
issue: TBD
status: proposed
last_updated: "2026-11-04"
---

# eve-code performance and surface reduction

## Summary

`eve/extensions/code` (eve-code) should contain only general coding behavior,
and every byte it sends to the model should earn its place on a coding
benchmark. Today it carries single-consumer code, a subagent no benchmark has
used, and a prompt written for a chat product.

What the evidence shows:

- **Bash output format was the main lever, not prompt text.** Sending core
  `bash` results to the model as plain text instead of JSON (#5822) took
  eve-code from 40/72 to 50/72 pooled on deepswe-lean, level with pi (25/36).
  Prompt blocks for verification and ambiguity added nothing measurable on top,
  and cost about a minute per task. See [Results](#results).
- **opencode still leads.** It resolved 32/36 once eve-bench sent its
  instruction once (eve-bench#104). The cause of the remaining gap is open.
- **The benchmark is underpowered.** 12 tasks at 3 attempts move about ±3 per
  run, so small effects cannot be told apart. Growing the task set (Phase 0)
  now gates further tuning.
  - swe-lean is not a coding benchmark. It is 4 terminal-bench tasks (eve-code
    94/100, opencode 92/100, pi 89/100) plus 3 MCP data tasks (eve-code 72/75,
    pi 56/75).
  - In earlier runs, only 4 of 12 deepswe-lean tasks separated the harnesses.
    7 were solved every time by everyone, and 2 almost never by anyone.
- **The model ignores eve-code's tools.** In 108 earlier deepswe-lean trials on
  `anthropic/claude-sonnet-5.5`:
  - `apply_patch` was called twice, `code__grep` 9 times, and `code__worker`
    never, even though the worker was offered.
  - Nearly all reads and edits went through `bash`. The model also called
    `write_file` 9 times, to create new files.
  - pi looks the same: zero calls to its `edit` or `read` tools.
- **Fixed prompt overhead is over 2x pi's.** In the baseline, the first step
  is about 7K input tokens including the task, against 3K for pi and 11K for
  opencode. eve core alone (default tools, Tasks section, skills section) is
  about 3K of that, so getting to pi's level needs more than eve-code changes.
  pi runs through `anthropic-messages` with prompt caching (eve-bench#103), so
  cost comparisons are like for like.
- **The read-only worker does not fit its job.**
  - Its only tools are `glob`, `grep`, and `read_file`
    (`test/scenario/worker-manifest.test.ts:73`). It cannot run `git diff`,
    read another ref, or run tests, unless the parent pastes the diff in.
  - It ignores the root model and calls `gpt-5.6-terra-fast` at `xhigh`.
  - The isolation also protects little. In the template's PR turns, the root
    agent already has the untrusted diff in context, alongside credentialed
    tools.

The plan has four parts: fix what the benchmark can detect, remove
single-consumer and unused API surface before 1.0.0, trim the prompt, then
improve the tools and context. Each behavior change is benchmarked on its own
and lands only if it does not make results worse.

## Results

deepswe-lean, `anthropic/claude-sonnet-5.5`, reasoning `high`, 3 attempts per
run. Variant runs are eve-code only, compared against the stored opencode and
pi baselines.

| Variant                       | PRs          | Resolved            | Runs                     | Notes                              |
| ----------------------------- | ------------ | ------------------- | ------------------------ | ---------------------------------- |
| `main`                        | –            | 20/36, 20/36: 40/72 | 41504242132, 41528486724 | Baseline                           |
| 2a, prompt trim               | #5800, #5805 | 23/36               | 41512622405              |                                    |
| 2a + 2b, verification block   | + #5807      | 24/36               | 41509319369              |                                    |
| 2a + 2b + 2c, ambiguity block | + #5812      | 25/36               | 41521242524              | Latency +1m44s                     |
| `bash` `timeout`, up to 120 s | #5813        | 19/36               | 41530685205              | Steps 21 to 17.5, sleeps 58 to 17  |
| Plain-text `bash` output      | #5822        | 26/36, 24/36: 50/72 | 41537553126, 41543980463 | Latency unchanged                  |
| All of the above              | #5825        | 22/36, 27/36: 49/72 | –                        | Latency +1m19s                     |
| opencode                      | –            | 32/36               | 41528486724              | After eve-bench#104 (29/36 before) |
| pi                            | –            | 25/36               | Stored                   | Prompt caching on (eve-bench#103)  |

- **Plain-text output** is the one change that moved resolve rate. It
  matches pi, with no latency cost.
- **Prompt blocks** (2b, 2c) stay within run noise over 2a, and the
  combination is no better than plain-text output alone. They cost about a
  minute per task, so #5807 and #5812 are closed.
- **2a stays.** It removes chat-product and single-consumer text and sends
  fewer tokens on every step, without lowering results.
- **`timeout` stays as an efficiency fix.** It does not change correctness.
  `running` results fall from 23 to 14, and `timeout N` wrappers from 29 to 11.
- **The gap to opencode is open.** Two hypotheses:
  - eve's AI Gateway v4 path shows thinking as "omitted", where the Messages
    API shows "summarized". This is at least an observability gap, and it may
    affect results.
  - Run noise of about ±3 hides effects of this size. Phase 0 task expansion
    comes first.

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
  worker. Phase 2a trims the rest.
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

   Done in vercel-labs/eve-bench#103. eve-bench#104 also sends opencode its
   instruction once, which re-baselined opencode at 32/36.

5. Make variants git refs. The extension is compiled into eve, and its
   instructions cannot be overridden, so each variant needs its own build.
6. Define the benchmark consumer contract. `packages/eve-code/agent/` owns the
   instructions and extension mount. eve-bench injects only instrumentation,
   task connections, and the sandbox. Drop the `E0_MODEL` default, then
   re-baseline, since changing the consumer makes stored baselines
   incomparable.
7. eve-bench follow-ups:
   - add the model to the PR-comment key, so both families can report on one
     PR;
   - show `--artifact` in the diagnostics `trials logs` hint;
   - let competitor-only runs publish baselines. Today they cannot.

Exit criterion: a baseline of current eve-code, opencode, and pi on both
models, with the margin and detectable effect stated. The Sonnet baseline
exists. The `gpt-6.1-sol` baseline first runs after #5806 merges. Item 2 is
now the gating item: no further tuning until the expanded set can detect
effects smaller than ±3 per run.

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

## Phase 2: Prompt trim

Three stacked variants of `extension/instructions.md` were measured (see
[Results](#results)). Only 2a lands:

- **2a, removals only (#5805), kept.** 4,942 to 1,636 characters. It removes:
  - the chat-product text and consumer writing policy;
  - the duplicated parallelism lines and the nonexistent `todo` tool;
  - the Minds text;
  - the `apply_patch` and `grep` directives, which the tool descriptions
    already carry.

  It moves "Issues and bugs" and "Analysis and design" into `code__investigate`.
  It keeps the safety rules, the AGENTS.md instruction, and a tool-neutral line
  to edit with the editing tool rather than the shell, so GPT runs keep an
  editing directive.

- **2b, verification block (#5807), and 2c, ambiguity block (#5812),
  closed.** No measurable gain over 2a, and about a minute more per task.

2a carries no identity or interaction policy, which belong to the consumer:
the benchmark consumer says "finish without asking", and the template says
"ask the one question you need answered". When the template upgrades, it
restates the consumer policies 2a removes.

## Phase 3: Tools and context

1. **Core `bash` output and wait.** Both change core `bash`, so every agent
   gets them, not only eve-code (#5892):
   - plain-text results: stdout, then stderr after a `[stderr]` line. A
     non-zero exit ends with `[exit code: N]` as an `error-text` result. The
     structured output that `execute` returns does not change;
   - an optional `timeout` input, 1-120 s, default 60 s, before a command
     goes to the background;
   - a truncated stream names a sandbox file with its full output.
2. **Edit tool.** Decided in #5892: core ships pi's `edit` as `edit_file`
   (`eve/tools/edit_file`), a default tool beside `write_file` for every model. `apply_patch` and its diagnostics are
   removed, along with the `code__apply_patch` override. In deepswe-lean on
   Sonnet, no harness called its edit tool, so the decision rests on matching
   pi and on less code. Revisit per-model selection only if the weekly GPT row
   shows `edit_file` failing where a patch tool would not. Selecting tools per
   model would need a core primitive, proposed as its own change.
3. **Stop mounting `code__grep`.** Done (#5815). #5892 also removes the
   `eve/extensions/code/tools` entry in the next major; import `grep` from
   `eve/tools/grep`.
4. **Project instructions.** The code extension reads the workspace root's
   `AGENTS.md`, or `CLAUDE.md`, once per session on the first turn, with one
   sandbox command capped at 64 KB, and adds it as a user instruction in pi's
   format (#5892). Core does not, because not every agent codes. Still open:
   - cwd, date, platform, and git branch;
   - parent-directory and nested files, which the instructions tell the model
     to read;
   - a file created after the first turn is not loaded until the next session.
5. **History growth.** History grows from about 11K to about 65K tokens per
   step over a deepswe-lean trial, and bash output volume equals pi's. Reduce
   per-step input, and track steps with the Phase 0 metrics.
6. **Core Tasks section.** About 1.3K characters on every step while the
   `agent` tool is present. If Phase 0 shows it matters, propose a shorter
   version in core, as its own change.

## Phase 4: Latency

eve-code has the fastest median on deepswe-lean (3m38s). The remaining fixed
cost is about 2.6s per trial outside model and tool time: start to healthy is
a median 1.1s, and start to first event is 1.5s. Break down what is left
before attributing it to eve, and track eve's share under
[turn performance](./turn-performance.md). Less per-step input is the main
lever. Prompt blocks cost about a minute per task, which is one reason 2b and
2c are closed.

## Sequencing

| Step | Repo      | Content                                              | Depends on                  | PR and state                                |
| ---- | --------- | ---------------------------------------------------- | --------------------------- | ------------------------------------------- |
| 1    | eve       | Phase 1 removals, `review` skill change, docs, tests | Nothing. Before 1.0.0       | #5800, auto-merge, awaiting approval        |
| 2    | consumer  | Vendor the prwatch helpers and `lookup-agent-run`    | Before taking the RC of 1   | –                                           |
| 3    | eve       | Template delegation and README update                | The RC release containing 1 | –                                           |
| 4    | eve-bench | Web off for eve-code, pi caching, overhead metrics   | –                           | eve-bench#103, merged                       |
| 5    | eve-bench | Send opencode its instruction once                   | –                           | eve-bench#104, merged                       |
| 6    | eve-bench | Variants as git refs, consumer contract, follow-ups  | –                           | –                                           |
| 7    | eve       | Two-family benchmark matrix, weekly deepswe-lean     | 4                           | #5806, auto-merge pending                   |
| 8    | eve       | Task expansion, margin, re-baseline on both families | 6, 7                        | –, gates further tuning                     |
| 9    | eve       | Prompt variant 2a                                    | 1                           | #5805, kept, retarget to `main` after #5800 |
| 10   | eve       | Prompt variants 2b and 2c                            | 9                           | #5807, #5812, closed                        |
| 11   | eve       | Plain-text `bash` output (core)                      | –                           | #5822, auto-merge pending                   |
| 12   | eve       | `bash` `timeout` (core)                              | –                           | #5813, auto-merge pending                   |
| 13   | eve       | Combined benchmark run, measurement only             | –                           | #5825, closed                               |
| 14   | eve       | Stop mounting `code__grep`                           | 1                           | #5815, stacked on #5800, pending            |
| 15   | eve       | Model-conditional tool availability (core)           | –                           | –                                           |
| 16   | eve       | `code__edit` and selection                           | 8, 15                       | –                                           |
| 17   | eve       | Dynamic-instructions sandbox or state access (core)  | –                           | –                                           |
| 18   | eve       | Environment context                                  | 8, 17                       | –                                           |

## Next steps

1. Land the kept changes: #5800, then #5805 and #5815 on `main`, plus #5822,
   #5813, and #5806.
2. Expand the deepswe-lean task set and set the margin (Phase 0, items 2 and
   3). Hold further prompt and tool tuning until then.
3. Re-baseline `main` with the kept changes on both model families.
4. Check whether thinking display ("omitted" on the AI Gateway v4 path,
   "summarized" on the Messages API) affects results or only observability.
5. Ship the eve-bench follow-ups (Phase 0, item 7).

## Risks

- **1.0.0 timing.** PR 1 breaks a stable entry point and must merge before
  1.0.0.
- **Detectability.** The current set moves about ±3 per run. If the expanded
  set still cannot detect a useful effect, changes are judged on step count,
  token, and latency metrics, and their correctness claims stay unproven.
- **Model family drift.** A change that helps one family can hurt the other.
  Every gate runs on both models.

## Evidence

- deepswe-lean baseline on `main`, run 41504242132: eve-code at `e65f42b`,
  Sonnet 5.5, reasoning `high`, 3 attempts, eve-code web tools off.
- deepswe-lean `main` with opencode re-baselined after eve-bench#104: run
  41528486724.
- Variant runs: see [Results](#results).
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
