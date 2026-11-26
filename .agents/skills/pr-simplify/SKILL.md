---
name: pr-simplify
description: Simplifies an eve PR or branch with fresh eyes. Distills the PR's target outcomes to replace bolted-on complexity with a simpler upfront design, unifies duplicate machinery and code paths onto one canonical implementation, and removes dead or unreachable code. Use when asked to simplify a PR or branch, or as the report-only simplification pass inside pr-shepherd.
metadata:
  internal: true
---

# PR simplify

Look at a PR or branch with fresh eyes and simplify it before merge. PRs that
have been iterated on accumulate bolted-on layers, duplicate machinery, and
dead code paths. Stepping back to the outcomes the change needs to achieve
often reveals a simpler upfront design that removes substantial complexity
while preserving every observable behavior.

Read [`AGENTS.md`](../../../AGENTS.md) first—especially its coding principles
(KISS, code is liability, lean core, stable APIs / semver) and testing tiers.

Two modes share one rubric:

- **Report-only mode** (used by [`pr-shepherd`](../pr-shepherd/SKILL.md), or
  when the user asks for simplification ideas without edits): inspect the diff
  and codebase, do not edit files, and return prioritized findings.
- **Apply mode** (standalone invocation on a PR or branch): run the fresh-eyes
  analysis, triage findings against the code, apply the accepted
  simplifications, and verify them.

## What to look for

Start by distilling the concrete outcomes, invariants, and contracts the PR is
trying to achieve from the PR description, diff, and tests—ignoring the
commit-by-commit path that produced the code. Then inspect the diff together
with surrounding code and repo callers across three areas:

### 1. Simpler upfront design (outcome-first)

- Bolted-on layers, adapters, glue wrappers, or intermediate transforms that
  only exist because requirements or fixes were layered on one by one.
- Special-case flags, mode switches, or multi-stage state plumbing that
  disappear if the data model, state ownership, or control flow is designed
  directly for the combined outcomes.
- New layers or hooks added where an existing core mechanism in `eve` already
  covers the need.

Ask: knowing all the outcomes this PR needs to deliver, what simpler structure
would have been written from scratch?

### 2. Duplicate machinery and code paths

- Parallel code paths, near-identical branches, or repeated parsing,
  normalization, validation, serialization, or wiring logic inside the PR that
  should converge on one canonical path.
- New helpers or machinery in the PR that reimplement something the repository
  already provides—search surrounding modules and shared utilities before
  keeping a second copy.
- Split sources of truth where two structures or paths track the same state
  and can drift apart.

Unify onto one canonical owner only when the paths truly share responsibility.
Do not fuse unrelated concerns into a leaky abstraction just because they look
syntactically similar.

### 3. Dead and unreachable code

- Unreachable branches, impossible fallback paths, or defensive guards whose
  conditions are already guaranteed upstream.
- Old code paths, compatibility shims, feature switches, or migration glue
  superseded by the PR's own changes.
- Unused parameters, options, fields, types, helpers, or exports—including
  test-only production seams that no production caller needs (see
  [`test-audit`](../test-audit/SKILL.md)).

Verify callers across the entire repository (not only the diff) before marking
anything dead. When removing dead or duplicated production code, also prune or
consolidate tests that existed only to exercise the deleted machinery while
keeping full behavior coverage on the canonical path.

## Report-only mode

1. Inspect the target diff:
   - For a PR: `gh pr view <n>` and `gh pr diff <n>`.
   - For a local branch without a PR: `git diff origin/main...HEAD`.
2. Read `AGENTS.md`, the full surrounding files touched by the diff, and
   existing repo callers or sibling utilities.
3. Do not edit files.
4. Report in this structure:
   - **Target outcomes**: a short bullet list of the observable behaviors and
     invariants the PR must preserve.
   - **Findings**, ordered by impact (`high`, `medium`, `low`), tagged as
     `design`, `duplicate`, or `dead-code`. For each finding give:
     - exact files and symbols/lines;
     - concrete evidence of what is bolted-on, duplicated, or unreachable
       (including checked callers or the existing canonical path in the repo);
     - the concrete simpler design or unified path;
     - confirmation that every outcome, edge case, and public API/semver
       contract is preserved, plus any tradeoff or risk.
   - Say plainly when the diff is already minimal and clean.

Stay scoped to the PR's problem space. Do not report style or naming nits,
speculative abstractions, or unrelated refactors outside the PR's surface.

## Triage

Verify every finding against the code and callers before editing.

- **Apply**:
  - Verified dead or unreachable code, superseded paths, unused helpers/options,
    and test-only seams with no non-test callers.
  - Duplicate machinery or parallel code paths that share one responsibility
    and collapse cleanly onto a single canonical path (within the PR or onto
    existing repo utilities).
  - Bolted-on internal complexity replaced by a clearly simpler design that
    reduces moving parts while preserving every outcome, edge case, invariant,
    and public API contract.
- **Skip**:
  - Style nits, renaming preferences, or rearrangements that do not reduce
    complexity or moving parts.
  - Premature or leaky abstractions that merge distinct responsibilities.
  - Refactors of unrelated subsystems outside the PR's surface (note as a
    follow-up only if genuinely valuable).
  - Changes that weaken safety guards, invariants, or clarity required by
    correctness or tests.
- **Ask the user**:
  - Simplifications that would change a public API, user-facing contract, or
    semver boundary.

## Apply mode (standalone)

Use this workflow when the user invokes `pr-simplify` directly rather than
through `pr-shepherd`:

1. **Get fresh eyes.** If you authored or iterated on the branch in the current
   conversation, spawn one read-only subagent with no conversation history to
   run [Report-only mode](#report-only-mode) on the PR or branch. Give it only
   the PR number or branch name, not your reasoning. If you already have fresh
   context on the branch, run report-only discovery yourself first.
2. **Triage** the report against the code using [Triage](#triage).
3. **Apply** accepted simplifications in a coherent pass. Keep the diff focused
   and preserve every observable outcome and public API contract.
4. **Verify**:
   - Run the fast checks from `AGENTS.md`: `pnpm fmt`, `pnpm lint`,
     `pnpm typecheck`, `pnpm guard:invariants` (when exports, comments, or
     invariants were touched), and the narrowest relevant tests covering the
     changed paths with their tier config.
   - If a structural simplification substantially reshaped implementation logic
     (beyond dead-code removal or minor deduplication), spawn one fresh-context
     read-only correctness reviewer on the simplified diff to confirm no bugs,
     races, or regressions were introduced.
5. **Do not commit, push, or merge** unless the user asked. If a PR already
   exists and simplifications changed architecture or behavior described in the
   PR body, note that the body should be updated with
   [`gh-pr-description`](../gh-pr-description/SKILL.md).
6. **Report** to the user:
   - Simplifications applied, grouped by design simplification, unified paths,
     and dead code removed, with net diff summary (`git diff --stat`).
   - Notable findings skipped or deferred to follow-up, and why.
   - Exact verification commands and outcomes (including any post-simplification
     correctness check).
