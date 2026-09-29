---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-09-29"
---

# Run observation Slack spike handoff

> **AI status:** Written entirely by AI; human review pending.

This is a **draft, not a shippable opt-in**. Continue from [the spike plan](./eve-run-observation-slack-spike.md) and use this handoff for the current implementation state. Do not enable observation on a production Slack agent yet. Related issue: [#1673](https://github.com/vercel/eve/issues/1673).

## Branch and protocol

- Branch: `benpankow/spike-run-observation-stack`, based on `8cecbb324ea462e9d1f4c977c364bd46241debc6` (the complete tasks + shared conversation reducer + TUI stack; PRs [#3878](https://github.com/vercel/eve/pull/3878), [#3879](https://github.com/vercel/eve/pull/3879), [#3880](https://github.com/vercel/eve/pull/3880)). Do not transplant just the reducer onto main's older `subagent.called` protocol. The selected stream version is **26**; child discovery uses `agent.started`, and task status uses `task.started` / `task.settled`.
- The branch is intentionally stacked on #3880, not on main. Recheck those PRs' merge/rebase state before rebasing.
- The spike switch is `slackChannel({ experimental: { runObservation: true } })`. Default Slack behavior is unchanged. Current factory rejects authored hooks/event overrides, approval routing, and legacy activity renderers with the switch. This switch exists in code but **must stay fixture-only** until admission and interaction gates are complete.

## Current implementation and proof (2026-09-29)

- The original branch diff was audited against `8cecbb324`; focused baseline unit suites passed (2 files, 3 tests) and integration suites passed (3 files, 4 tests) with the tier configs. PR #3946 remains a draft against `refactor/tui-agent-store`.
- Packages A–F are partially implemented: a distinct, hook-claimed Workflow launches once from root initialization and runs observation and delivery branches concurrently. Indexed local pages and parent-bound direct remote-child pages use saved source cursors; child discovery and presentation use the shared conversation reducer. The fixture caps root turns, sources, checkpoint bytes, objects, and expiry. No parent presentation inbox or per-progress parent step was introduced.
- Root completed text, lone-`task_wait` narration, safe direct-task activity, generic root errors, and transient status are projected into keyed Slack objects. The delivery branch journals intent, effect, and receipt steps. A real Workflow step retry after fake Slack accepts a create and loses its response performs metadata recovery, records the provider's actual text, and updates stale content with one create. An inconclusive lookup becomes `unconfirmed_create` and does not repost.
- A separate `run-observation-crash.scenario.test.ts` boots an inline Slack fixture with no default extensions and a strict fake transport. The fake accepts and persists the create, then exits its development worker before returning. The restarted worker performs metadata recovery and updates stale text; the test confirms different worker identities and exactly one `chat.postMessage`. This proves a **local development worker crash/replay**, not a Vercel redeployment or cross-deployment handoff. The earlier parked-root reply test remains a separate, weaker proof.
- Direct remote-child integration reads use the recorded parent/call/child path, a fresh authored resolver, stream-version normalization, split NDJSON, and independent cursors. Local and remote readers retain complete records before a truncated final record; a missing remote captured tail or one behind the saved cursor is rejected. A real Workflow integration holds Slack delivery while a late child page checkpoints after root terminal, and a 429 `Retry-After` case expires with an undelivered-object report. A failure step records source cursors and remaining objects in the Workflow journal. Duplicate hook claim, parked-root reply, and parent-step absence have separate Workflow tests.
- A later correction to a known Slack message now plans an update even for a retained reply. Expiry/failure reporting compares the applied payload version and provider ID with the latest desired object, so a stale `confirmed` receipt is reported as undelivered instead of silently counting as complete. Focused planner and report regressions failed on the prior code and pass after this change.
- Fixture admission requires `requestInput: false` explicitly and disables uploads, requires plain-text input and an existing thread, and rejects non-framework tools/connections and dynamic resolvers across the compiled graph. The inert framework connection-search resolver is allowed only because connections are rejected. The development scenario exposed default extensions that contributed tools and resolvers; it disables those extensions rather than weakening admission. The stock observer switch remains off by default; enabled sessions suppress legacy outbound handlers, activity collection, and ingress typing. The switch is **not** installed as a general registry mode and must not be used by a production agent.

## Outbound capability boundary

| Existing path                         | Trigger/context and provider effect                                                                    | Spike owner                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Reply and task-wait narration         | `message.completed` / `step.completed`; thread post or long-reply upload                               | Observer for bounded text; upload blocked           |
| Typing, reasoning, action status      | turn/reasoning/actions and default inbound mention/DM; assistant thread status                         | Observer status; inbound typing suppressed          |
| Root errors                           | turn/session failure; thread post                                                                      | Observer generic keyed error                        |
| Question/approval card and settlement | input request and approval settlement; responder context, card receipts, private or public post/update | Unsupported; fixture rejects interactive capability |
| Authorization challenge/completion    | authorization event plus triggering user/candidate; public status, private link/code, later update     | Unsupported; authored connections rejected          |
| Candidate notices                     | approval candidate plus responder identity; ephemeral post                                             | Unsupported; approval routing rejected              |
| Files and long replies                | inbound upload or outbound snippet/file upload                                                         | Disabled or blocked                                 |
| Proactive anchor and alias            | receive without an existing thread; post plus route association                                        | Rejected at fixture admission                       |

This audit is limited to built-in paths. Arbitrary authored ingress hooks and event overrides are rejected with the switch. No private recipient or provider destination is reconstructed from public message text.

## Still blocking the spike's required proofs

1. The local process-crash proof now passes. Still test a source-read crash before its checkpoint, duplicate owner startup across restart, and deployment-generation handoff. The planning/receipt ledger remains workflow-body state between journaled steps; the local crash proves one create window, not every replay ordering. Keep PR #3946 draft until the full required proofs pass and maintainers review them.
2. Run a deployed direct-remote-child scenario with real parent/child routing and retained-history behavior. The in-memory fake HTTP test proves the reader contract, not deployment authorization, origin failover, or all truncation modes. Nested descendants remain explicitly unsupported; source history retention completeness is unverified.
3. Produce same-machine off/on measurements for parent latency/activation, sidecar polls/bytes/history, source-to-observation and observation-to-provider latency, coalescing/retries, and 1/4/16 direct-child loads across shared provider quota. No numerical overhead claim is yet warranted.
4. Add the deterministic fixture-owned CI eval and inspect CI. The local crash scenario ran; no observation e2e suite ran. The earlier PR-head local/Vercel e2e failures predate this unpushed continuation and are not evidence about these changes.
5. Package G remains a separate review gate: approvals, auth/privacy, files, long replies, proactive anchors, and general opt-in/lifetime/quotas are not implemented. Do not make live Slack calls or merge this draft on the strength of fixture tests.

## Checks actually run

- After the latest source changes: focused unit Vitest with `vitest.unit.config.ts` passed **5 files / 148 tests** (observation state/view/plan, shared reducer, Slack channel); focused integration Vitest with `vitest.integration.config.ts` passed **4 files / 12 tests** (Workflow ownership, local/remote readers, observer delivery). Both suites use the source aliases, not bare Vitest.
- After the retained-reply/report correction, the planner unit file passed **1 test**, the new failure-report integration file passed **1 test**, the Workflow integration file passed **6 tests**, and the development-worker crash scenario passed **1 test**, each with its tier config. These focused reruns do not replace the earlier full focused-suite counts above.
- The focused scenario Vitest with `vitest.scenario.config.ts` passed **1 file / 1 test** after the fixture admission correction and worker-identity assertion. Earlier diagnostic runs failed before reaching the provider effect because default extensions contributed unsupported tools/resolvers; they were not crash/replay failures.
- `pnpm build`, `pnpm --filter eve typecheck`, full `pnpm typecheck` (50 tasks), `pnpm fmt`, `pnpm lint` (pre-existing warnings only), `pnpm guard:invariants`, `pnpm docs:check`, and `git diff --check` passed after the admission cleanup. After the retained-reply/report correction, `pnpm fmt`, `pnpm lint` (same warnings), full `pnpm typecheck` (50 tasks), `pnpm guard:invariants`, `pnpm docs:check`, and `git diff --check` passed again. Full `pnpm build` was not rerun for that last correction; the full typecheck's build dependency completed, and the crash scenario ran against it.
- No e2e, deployed remote, real Slack, or quantitative off/on measurement ran. No commit or push was made for this continuation; this checkout has no configured signing key, and the available SSH agent/GPG key checks found no usable signing identity.
