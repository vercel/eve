# Self-modification e2e fixture

This fixture uses `eve eval` to test a parent delegating a source change to the real self-modification child, rebuilding the agent, and using the result in a new conversation. CI runs the default root model and the standard self-modification child with eve's default model. Independent parent/child model selection is not part of this fixture.

The fixture installs Vercel Connect because the generated deployed configuration supplies a Connect-backed credential provider to eve. These local cases do not request Connect credentials.

Routing-only cases remain in [`agent-subagents`](../agent-subagents/evals/self-modification/), where an acceptance-only child avoids performing real integration installs.

## Fixture preparation

`pnpm run e2e:prepare` copies the `eve/self-modification` scaffold from this checkout using the source and target paths in `apps/docs/registry.json`. The generated `agent/extensions/self-modification/` directory is gitignored and replaced on each preparation; no registry fetch, dependency installation, or credential setup runs.

The fixture's `build`, `dev`, `typecheck`, and `test:e2e` scripts prepare the scaffold before starting eve. The local e2e CI workflow also runs `e2e:prepare` before invoking `eve eval` directly. For a direct CLI invocation, prepare first. Do not prepare while an eval or dev server is running: preparation replaces the generated subtree.

This exercises the current standard scaffold without duplicating it in the fixture. Registry installer behavior is outside these evals' scope. Dependencies remain declared in the fixture's `package.json`.

## Cases

- `add-agent-browser.eval.ts` asks for browser automation without naming a registry address. It checks the child's registry search and approved install, and compares the resulting extension with the checkout's official registry source. `add-slack-channel.eval.ts` similarly checks discovery, then verifies that the setup-bearing Slack item is handed off to `eve add channel/slack` without installation. Neither case needs service credentials or an external account.
- `create-incident-triage.eval.ts` creates an incident-triage tool and checks precedence and threshold rules across typed inputs.
- `create-shipping-quote.eval.ts` creates a quote calculator and checks destination, started-kilogram, free-shipping, and expedited pricing boundaries.
- `offer-repair.eval.ts` reproduces an incorrect reorder recommendation, checks that the parent offers but does not start a repair, confirms it, and verifies the repaired tool.
- `repair-order-total.eval.ts` first reproduces quantity and discount errors in the fixture's existing tool, asks self-mod to investigate the incorrect invoice, and verifies the fix, cent rounding, and single-item/empty-order regressions.

Each case checks actual tool inputs and outputs, not the assistant's claim that the work succeeded. Cases also reject source changes outside their specified target. The registry cases serve only the selected checkout-owned manifests on loopback via `EVE_DEV_OFFICIAL_REGISTRY_URL`; this exercises `registry_add` and `eve add` without depending on eve.dev. They verify agent-browser installation and the Slack setup handoff, not browser automation or channel activation. The arithmetic cases use synthetic data and do not require external services. These checks cover the specified behavior; they are not a general security audit of generated code.

## Adding a case

Wrap source-mutating cases in `withSelfModification(t, async (selfMod) => { ... })` from `evals/self-modification/harness.ts`:

1. Establish the initial state. For a repair, invoke the existing tool and assert its known incorrect output before asking for a fix.
2. Use `selfMod.request(prompt)` to start the parent and follow the delegated child. Describe the user-visible requirement or symptom, not a prescribed patch.
3. Use `selfMod.assertOnlyChanged(paths)` to check the permitted edit scope, then `selfMod.apply()` to force a runtime rebuild.
4. Use `selfMod.verify(prompt)` to invoke the tool in a fresh session. Assert the call's input and structured output with `requireToolCall`, including boundary cases and previously working behavior.

The harness snapshots the complete `agent/` tree plus installer-mutated project files, tracks sessions, and retires them before restoring source. Restoration removes unexpected files and restores deleted files, binary contents, and file modes. Source watching is suspended during restoration. If session retirement or restoration fails, later mutation cases fail instead of continuing against uncertain state; failed retirement retains the backup path in the error.

Keep `maxConcurrency: 1`. The harness also serializes cleanup that continues after an eval timeout and acquires a checkout lock before snapshotting source. A concurrent `eve eval` process fails before mutation. If cleanup cannot safely restore source, the lock remains with owner diagnostics; remove it only after inspecting the retained backup and confirming no eval or development server is mutating the fixture.

Forced rebuilds isolate source-authoring and runtime correctness in the other cases. These cases do not verify deployed proposal/merge behavior. Real-model e2e runs belong in CI. The fixture-only cleanup tests need no model or running server:

```sh
pnpm --filter agent-self-modification test:scenario
```
