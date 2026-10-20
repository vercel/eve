---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-13"
---

# Reviewing the instrumentation changes

This guide is for reviewing the instrumentation changes in stack #4696. Two PRs carry nearly all
of them: PR 2 rebuilds provider events from committed facts, and PR 10 gives providers the
stream's names. Together they are −380 production lines in `instrumentation/` and `tracing/`. File
names below link to each file's diff in the PR that changes it.

## Where the changes are

| PR                                                    | Instrumentation changes                                                                                                                                                                               | Production lines |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------: |
| #4549                                                 | [`invoke-tool-parity.integration.test.ts`](https://github.com/vercel/eve/pull/4549/files#diff-b7c899a842992e491c5daaeb2ceb33e0d1ba1f069a2dbe32778db2bd5ac01a42) follows the one executor (tests only) |                0 |
| 2 · [#4567](https://github.com/vercel/eve/pull/4567)  | Provider events built from committed facts; private scope maps deleted                                                                                                                                |             −245 |
| 3 · [#4574](https://github.com/vercel/eve/pull/4574)  | The [instrumentation guide](https://github.com/vercel/eve/pull/4574/files#diff-400e475d77b8045bc589b72e757bce16cbda34d7fa2639d1f98c25b2fff7450b) follows v27                                          |        docs only |
| 9 · [#4694](https://github.com/vercel/eve/pull/4694)  | [One retention test](https://github.com/vercel/eve/pull/4694/files#diff-edfb65b460adeb0601817432049651bd90ad8276cc00dcef00b7b7135366b06d) follows the running-work record (tests only)                |                0 |
| 10 · [#4695](https://github.com/vercel/eve/pull/4695) | The stream's names, one ending per operation, the OTel provider's turn endings                                                                                                                        |             −135 |

Production lines exclude tests. PR 2 also changes the call sites that feed instrumentation,
mainly [`execution/publish-session-events.ts`](https://github.com/vercel/eve/pull/4567/files#diff-6313f834f1303803f63fe73199c8a98469e1f197993ff1a4abef87b6c484077b) and [`harness/tool-loop.ts`](https://github.com/vercel/eve/pull/4567/files#diff-b11c857a5e7689f89d96a7ee3ff2f99ab60b0371026dd6530606483e50f9514d).

## PR 2: events from committed facts

On main, instrumentation rebuilt each operation from v26 events and kept private maps to know
which attempt a call or request belonged to. On the stack, `createInstrumentationHandleEvent`
([`instrumentation/native-events.ts`](https://github.com/vercel/eve/pull/4567/files#diff-934630d704f34bf12bd3d2ae4479f4f194c1d1d162ee40581caf8304235c105a)) wraps the publisher. After each line is written, it maps
every committed fact, with the session's tables after that line, to provider events.

What's deleted:

- The per-call and per-request scope maps: 157 lines of [`instrumentation/state.ts`](https://github.com/vercel/eve/pull/4567/files#diff-ef1888eeaf3eeba06d79a847819f639129d466f26ef3e0c65186995c49ca0df8). The file
  keeps only the durable `ctx.state` slots.
- `setAttemptScope`/`getAttemptScope`, which [`tool-loop.ts`](https://github.com/vercel/eve/pull/4567/files#diff-b11c857a5e7689f89d96a7ee3ff2f99ab60b0371026dd6530606483e50f9514d), [`model-call/run.ts`](https://github.com/vercel/eve/pull/4567/files#diff-c193de4b3454659c61bcbe69a931438e4cd92d41dd3b57905d46a32ce7c6dff1),
  [`model-call/call.ts`](https://github.com/vercel/eve/pull/4567/files#diff-eda2f07a185a8f95444e35509c60caa957ee80a2877ba75ac432d244a6fe9eb1) and [`hitl/intake.ts`](https://github.com/vercel/eve/pull/4567/files#diff-9ca11c72f7003dab0d856d55e02d15d6b4ac9cbaa5bdc5fc4c0fee2623fcd87f) called to tell instrumentation which attempt was
  running.
- HITL's `publishInputResolutions`. Interaction endings now come from `interaction.settled`.
- 49 lines of [`dispatch.ts`](https://github.com/vercel/eve/pull/4567/files#diff-12181930822e7f166f6cf62418bf20c4d32d796e708c260917347f9b380f3bc2) and 66 of [`runtime.ts`](https://github.com/vercel/eve/pull/4567/files#diff-e503289a595a62ce6762636301e1523914a066a47bd408e97567309df60e8843) that served the maps.

What to check:

- **One event per fact, after the line is written.** Events derive from the fact and the tables;
  nothing is published from inside a step.
- **What an ending closes is heard too.** When a line holds an ending, the transform recomputes
  the writer's cascade (`cascade(before, published)`) so a turn's end also produces `call.settled`
  with `interrupted` for its open calls. Check that this matches the line the writer commits. A
  test in [`native-events.test.ts`](https://github.com/vercel/eve/pull/4567/files#diff-4e3099d118143f9c3695efc82c5277c7ae87cecfd865a5de72c21667619e16e6) covers it ("hears what a turn's end closes with it, as the
  writer commits it").
- **Attempt scope comes from the run row.** A call's or request's attempt is its run's current
  attempt (`runAttempt`, `callRun`). A replacement run continues the attempt count of the run a
  retry gave up.
- **Sign-ins produce no interaction events.** `interactionAttempt` skips `kind: "sign-in"`;
  main's input events had no sign-in kind either.
- **Request kinds are the interaction's.** `kind` on interaction events is `question`, `approval`
  or `budget`, where main's input events had `question`, `tool-approval` and `session-limit`.
  The instrumentation guide's upgrade table lists the rename.
- **Agent calls are deferred.** `call.requested` for an agent call sets `isWorkflowTool`, because
  the child session reports its own start.
- **Remote agents.** PR 2 reports a remote agent's call as a subagent call, because the call's
  capability doesn't say which it is. PR 10 adds that to the capability.

## PR 10: the stream's names

The four families the stream records take the stream's names, and each operation ends with one
event that carries the fact's outcome:

| Main                                              | Stack                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `session.completed`, `session.failed`             | `session.ended` with `outcome` `completed` or `failed`             |
| `session.waiting`                                 | Removed. v27 has no waiting event                                  |
| `turn.completed`, `turn.cancelled`, `turn.failed` | `turn.settled` with `outcome` `completed`, `cancelled` or `failed` |
| `tool.call.started`, `completed`, `failed`        | `call.requested`, `call.settled` with a `CallOutcome`              |
| `input.requested`, `input.resolved`               | `interaction.opened`, `interaction.settled` with its outcome       |

Step attempt, model call, memory and channel delivery events keep their names, as do `ctx.state`
and `idempotencyKey`. OpenTelemetry trace schema 4 and its span names don't change. A direct
`invokeTool` emits the same `call.requested`/`call.settled` pair ([`tracing/invoke-tool-span.ts`](https://github.com/vercel/eve/pull/4695/files#diff-c997e761bc23b44105adc3ea367b64fb35793ff3566748ecd1e34fc8a2297527)).

Where the change lands:

- **Types.** [`lifecycle.ts`](https://github.com/vercel/eve/pull/4695/files#diff-09fdd9b376516d334730910d55ea604a3f464cf30e0966cbc28cd6af70372582) replaces the per-ending event types with one ending type per family;
  `InstrumentationSessionOutcome` and `InstrumentationTurnOutcome` are the stream's own
  `SessionOutcome` and `TurnOutcome`. [`provider.ts`](https://github.com/vercel/eve/pull/4695/files#diff-459a9c564f778cc6f8e9d8331492c8b143186def51440884a837acf15714bd5e) re-exports the new names.
- **Events.** [`native-events.ts`](https://github.com/vercel/eve/pull/4695/files#diff-934630d704f34bf12bd3d2ae4479f4f194c1d1d162ee40581caf8304235c105a) builds each family's start and ending under the new names.
- **Dispatch.** [`dispatch.ts`](https://github.com/vercel/eve/pull/4695/files#diff-12181930822e7f166f6cf62418bf20c4d32d796e708c260917347f9b380f3bc2) releases a provider's `ctx.state` on the new endings, and on
  `session.ended` and `turn.settled` for state a missing ending would leave behind.
- **Content.** [`content.ts`](https://github.com/vercel/eve/pull/4695/files#diff-7547b5b03f4a36225bdd88255f602f5e6245ade35c0abf54d43c409709ff08cd) projects `answer`, `request`, `input` and `output` on the new names
  under each provider's `tracePolicy`. Without outputs, `call.settled` now drops `output` and
  `error` entirely, where main's `tool.call.completed` kept the output's `type`.
- **OTel provider.** [`tracing/agent-otel-provider.ts`](https://github.com/vercel/eve/pull/4695/files#diff-24cfd1932ec0105fb3e719cb8f35c13093bcdb1b6e47204bad03cc934e79c7c7) ends a turn's span at `turn.settled`, with
  its outcome, or at `session.ended` for a turn the session's end left open. The stored terminal
  ([`agent-trace-state.ts`](https://github.com/vercel/eve/pull/4695/files#diff-a93dfab821023218bee7118e28104f3d2478a4011e43dd814b4662fd46deb10e)), its codec ([`agent-trace-context-codec.ts`](https://github.com/vercel/eve/pull/4695/files#diff-880b00fb2929e63c53e52fffa607ca1abbaf7e12a1794b6f316d6eb533ee6173)) and its error serializer go,
  about 50 lines; an older stored terminal is ignored when read. Tool and approval spans read
  `call.*` and `interaction.*` ([`agent-tool-instrumentation.ts`](https://github.com/vercel/eve/pull/4695/files#diff-0aab61395a2aa169128f3c1c1d8c6fd907ccd2dce3440f638d5784665d8587d9), [`agent-approval-instrumentation.ts`](https://github.com/vercel/eve/pull/4695/files#diff-d43bac22cb13e472132709c4f35f35db76a2bf1325f25cdf8ef0035135d60507)).
- **Remote agents.** A call's capability has `remote: true` when another deployment serves the
  agent ([`harness/call-facts.ts`](https://github.com/vercel/eve/pull/4695/files#diff-ff246f639bc3c3b53da831379653918f683d3141d4a9336ed534d544a471b8e5), [`protocol/session-events/families/call.ts`](https://github.com/vercel/eve/pull/4695/files#diff-e0d62f9fd478cd20e6e43d6615b7f76cfa9cb8ac837f168a835202be86bd8ae2)), and
  `native-events.ts` reports such a call as `remote-agent-call`, so remote agent spans keep their
  `CLIENT` kind and `agent.action.kind`. The hook, channel, schedule and tool contract reports are
  regenerated for the field.
- **Docs and changeset.** The [instrumentation guide](https://github.com/vercel/eve/pull/4695/files#diff-400e475d77b8045bc589b72e757bce16cbda34d7fa2639d1f98c25b2fff7450b)'s event table, upgrade table and examples use the new
  names, and the [upgrade guide](https://github.com/vercel/eve/pull/4695/files#diff-d38e438a9c19bb131b8a2bebf1fc4e49f904d63987406ed081b2c2724af6b560) points to them. [`.changeset/instrumentation-vocabulary.md`](https://github.com/vercel/eve/pull/4695/files#diff-6999e29e72d11afe8ea702b0bb1c423ef357e366d9ad298a7c5449be0b0108e1) is a `minor`
  note.

What to check:

- **When a turn's span ends.** Main ends it at the next session transition, usually
  `session.waiting`, and deletes the turn's trace state then. The stack ends it, and deletes that
  state, at `turn.settled`. The turn's channel delivery still reaches the span: its ending comes
  from the same `turn.settled` fact and is published first, which a test in
  [`native-events.test.ts`](https://github.com/vercel/eve/pull/4695/files#diff-4e3099d118143f9c3695efc82c5277c7ae87cecfd865a5de72c21667619e16e6) pins.
- **Old names fail quietly.** A provider keyed on a removed name gets a type error, but at runtime
  its handler never fires. A hook keyed on a removed v26 event fails at load and names the
  replacement; instrumentation has no such check.

## Main's tracing library

After the stack's base, main moved span layout, capture and durable recovery into `@eve/tracing`
(#4160, #4164) and moved eve's adapter to `tracing/eve/*`. Main didn't change the provider API, so
the stack conflicts only in the adapter. The restack ports about 24 references to the old names
in six `tracing/eve/*` files and drops the adapter's stored turn ending. PR 2 deleted three tracing
suites, 5,289 lines ([`agent-otel-provider.test.ts`](https://github.com/vercel/eve/pull/4567/files#diff-88ac78a09f6628ef945508b1abd79bffc34c0d5210f7820c84a17a5884d92ec0), the telemetry contract test and the invoke-tool
parity test); the restack can restore them from main's copies.
