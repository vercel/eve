---
issue: TBD
status: proposed
last_updated: "2026-09-02"
---

# Durable retries for semantic errors

> **AI status:** Written entirely by AI; human review pending.

## Summary

Some failures are known to clear after a bounded wait, but eve currently has only two model-call recovery paths: short in-process retries for generic transient failures, or a failed turn that parks for user-driven recovery. AI Gateway free-tier rate limits expose the gap. The current Gateway response is a retryable `429 rate_limit_exceeded`; exact-limit responses may include `Retry-After`, while legacy WAF responses use a 60-second window without reset metadata. Retrying after 500 ms and 1 second is ineffective, but requiring the user to resend is unnecessary.

Add an optional durable-retry policy to semantic error rules. When a matched failure permits durable retry, the harness resolves a concrete delay from the response or the rule default, emits a nonterminal `step.failed` carrying semantic-error and scheduled-recovery metadata, commits the retryable step state, and returns control to the existing durable turn sleep. The same turn resumes after the wait. If the bounded retry succeeds, it completes normally; if it fails, the existing `step.failed` → `turn.failed` → `session.waiting` path remains unchanged.

Channels consume generic scheduled-recovery metadata. Each channel renders its own notice according to its formatting and transport constraints; no channel branches on AI Gateway error text or semantic error IDs.

## Goals

- Automatically retry known wait-recoverable model failures without holding a function invocation open.
- Honor server-provided retry timing and use a semantic-rule default when none is available.
- Keep the retry in the same user turn and preserve the original prompt and durable session state.
- Notify users through every built-in channel before the workflow sleeps.
- Keep retry policy centralized in the semantic-error catalog and presentation channel-local.
- Bound attempts and delays so malformed upstream data cannot create unbounded work or sleeps.
- Preserve the legacy 403 free-tier error classification while adding current 429 coverage.

## Non-goals

- Automatically retry every error tagged `transient` or `recoverable`.
- Introduce a new stream event type.
- Standardize message formatting across channels.
- Expose semantic retry configuration as an authored agent API.
- Retry terminal configuration, authentication, billing, model-access, or malformed-request failures.
- Change AI Gateway's limits. Gateway should separately add reset headers to legacy WAF 429s.

## Semantic recovery model

Extend `SemanticErrorRule` and `SemanticErrorSummary` with an optional internal recovery policy:

```ts
export interface SemanticErrorDurableRetryPolicy {
  readonly kind: "durable-retry";
  readonly defaultDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs?: number;
}

export interface SemanticErrorRule {
  // Existing fields...
  readonly recovery?: SemanticErrorDurableRetryPolicy;
}
```

The catalog owns whether a failure is safe to repeat and the fallback timing. `transient` continues to mean that the existing short retry loop may retry immediately. `recovery.kind === "durable-retry"` is a separate, explicit capability: it means the request may be repeated across a durable step boundary after a meaningful wait.

For the free-tier Gateway rule:

```ts
{
  id: "gateway-free-tier-rate-limited",
  name: "AI Gateway free tier rate limit exceeded",
  tags: ["gateway", "transient"],
  when: messageMatches(/Free tier requests on this model are rate-limited/),
  message: (link) => link.message,
  hint: "Reduce request volume or add AI Gateway credits for higher limits.",
  recovery: {
    kind: "durable-retry",
    defaultDelayMs: 60_000,
    maxAttempts: 1,
    maxDelayMs: 300_000,
  },
}
```

The fallback is 60 seconds because the matching legacy Gateway path is backed by a 60-second WAF window and emits no `Retry-After`. The five-minute cap permits conservative server guidance while preventing hostile or malformed headers from parking a turn indefinitely. These values are implementation defaults, not a public timing guarantee.

`evaluateSemanticErrorRules` projects `recovery` unchanged into the summary. Rule validation tests require positive safe-integer delays, a positive safe-integer attempt count, and `maxDelayMs >= defaultDelayMs` when a cap is present.

## Resolved recovery metadata

The semantic rule describes policy; the harness records what it actually scheduled. Add an eve-owned JSON shape under failure `details`:

```ts
interface ScheduledRecoveryDetails {
  readonly kind: "durable-retry";
  readonly status: "scheduled";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
}
```

A retryable `step.failed` resembles:

```json
{
  "errorId": "err_...",
  "semanticErrorId": "gateway-free-tier-rate-limited",
  "name": "AI Gateway free tier rate limit exceeded",
  "message": "Free tier requests on this model are rate-limited.",
  "hint": "Reduce request volume or add AI Gateway credits for higher limits.",
  "recovery": {
    "kind": "durable-retry",
    "status": "scheduled",
    "attempt": 1,
    "maxAttempts": 1,
    "delayMs": 42000
  }
}
```

Keep this in `details` rather than adding fields to `StepFailedStreamEvent`. The event remains truthful—one model step failed—and existing stream consumers remain source-compatible. The metadata is machine-readable but not a new public control primitive.

## Retry timing

Add a structural extractor in `harness/model-call-error.ts` that walks the cause chain and reads `responseHeaders` from the nested AI SDK `APICallError`. It returns a delay only when a recognized semantic rule has opted into durable retry.

Support both standard `Retry-After` forms:

- non-negative integer seconds;
- HTTP date, converted to `date - now`.

Resolution order:

1. valid `Retry-After` from the cause chain;
2. semantic policy `defaultDelayMs`;
3. clamp to at least 1 second and at most `maxDelayMs`;
4. add bounded positive jitter only to fallback delays, not server-directed delays.

Do not use `x-ratelimit-reset-*` initially. Gateway already emits `Retry-After` alongside those headers on exact-limit responses, and supporting one standard source avoids conflicting reset interpretations. The extractor should preserve the chosen source in logs but need not expose it to channels.

The existing 500 ms exponential retry loop must not consume this failure first. Durable-retry semantic matches take precedence over `isRetryable` and generic 429 classification. Other 429s retain the existing three-attempt behavior.

## Durable retry state

Store bounded state on `HarnessSession.state` under an eve-owned key, for example `eve.harness.semanticRecovery`:

```ts
interface PendingSemanticRecovery {
  readonly semanticErrorId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}
```

The state module owns parsing, incrementing, and clearing. A record applies only when both `turnId` and `semanticErrorId` match. Corrupt or stale data is ignored and removed rather than extending the retry budget.

Lifecycle:

- The first eligible failure schedules attempt 1 and persists the record.
- A resumed failure of the same semantic error schedules another retry only while `attempt < maxAttempts`.
- A successful model call clears the record before committing the step result.
- A different semantic error starts only its own policy budget; it does not inherit attempts from the earlier rule.
- Turn completion, cancellation, terminal failure, and user-driven parking clear the record.
- A new turn cannot inherit an old turn's recovery budget because the persisted `turnId` must match.

For the initial implementation, `maxAttempts` is one. The generic state shape supports later policies without changing the durable snapshot contract.

## Harness lifecycle

Add a dedicated durable-recovery branch after the existing specialized recovery pipeline fails and before the terminal/recoverable classification emits a turn outcome.

Eligibility requires all of the following:

- `summarizeKnownError` returns a rule with `recovery.kind === "durable-retry"`;
- the current run is conversation mode;
- an event emitter is present;
- the persisted attempt budget is not exhausted;
- the turn has not been cancelled;
- the failure occurred before any successful model step result was committed.

Task mode keeps its current durable step retry behavior in the first version. Delegated conversation turns may use the same mechanism because their turn workflow already supports durable sleep, but task-owned callback notification remains out of scope.

When eligible:

1. Build normal semantic failure details and merge resolved `recovery` metadata.
2. Emit `step.failed` only—do not emit `turn.failed` or `session.waiting`.
3. Advance the harness emission state so the resumed model call uses the next `stepIndex`.
4. Persist the original durable turn input in session history exactly once so `runStep(session)` can reconstruct the same request without another `StepInput`.
5. Persist the pending recovery state.
6. Call `requestTurnSleep(delayMs)`.
7. Return `{ next: runStep, session }`.

`turnStep` already projects `requestTurnSleep` into `sleepDurationMs`; `turnWorkflow` already performs `workflowSleep(durationMs)`, races cancellation, and invokes the next step. No timer, queue, cron, synthetic delivery, or second turn is required.

The resumed step receives no new `StepInput`, so it does not re-emit `turn.started` or `message.received`. It reads the committed prompt from session history, emits `step.started` at the advanced index, and performs the model call in the same turn.

### History invariant

The implementation must reuse the same history-building logic used by successful steps rather than append raw `StepInput` ad hoc. The committed retry snapshot includes durable context, staged attachment references, dynamic instruction messages, and the normalized user message exactly once. Ephemeral client context remains ephemeral, matching subsequent tool-loop steps today.

Add a small helper that commits the pre-call durable messages and use it in both normal success handling and scheduled recovery if necessary. Avoid storing a second copy of the entire prompt under the recovery state key.

### Partial-output guard

A rate-limit rejection normally happens before assistant content, but the generic mechanism must not replay a request after visible partial output or actions. Track whether the failing attempt emitted assistant/reasoning/action output. If it did, do not schedule durable recovery; fall through to the existing recoverable failure path. `step.started` itself does not disqualify recovery.

This guard prevents duplicate replies and repeated side effects if a future semantic rule is attached to a mid-stream provider error.

## Failure event semantics

The resulting event sequences are:

Successful retry:

```text
turn.started
message.received
step.started       # index 0
step.failed        # index 0, recovery.status = scheduled
[d durable sleep]
step.started       # index 1
step.completed     # index 1
turn.completed
session.waiting
```

Exhausted retry:

```text
turn.started
message.received
step.started       # index 0
step.failed        # scheduled
[d durable sleep]
step.started       # index 1
step.failed        # ordinary terminal-for-turn failure
turn.failed
session.waiting
```

The final failure retains the semantic summary and remediation but omits `recovery.status = scheduled`. It may include exhausted recovery metadata in private logs; channels need only know that no further automatic retry is scheduled.

## Channel integration

Add `"step.failed"` to the typed event interfaces for Slack, Discord, Teams, Telegram, Twilio, GitHub, and Linear. Each remains optional and merges over its built-in default like existing event handlers.

Extract only safe structural parsing into a shared channel utility:

```ts
interface ScheduledRecoveryNotice {
  readonly delayMs: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly semanticError: {
    readonly name: string;
    readonly message: string;
    readonly hint?: string;
  };
}

extractScheduledRecoveryNotice(event): ScheduledRecoveryNotice | null
```

The parser validates `details.semanticErrorId`, `name`, `message`, and the complete scheduled-recovery shape. Unknown recovery kinds, malformed values, unscheduled failures, and failures without semantic summaries return `null`. It does not import the semantic catalog or branch on IDs.

Rendering stays local to each channel:

- **Slack:** thread reply using Slack markdown/blocks and existing truncation limits.
- **Teams:** thread post using Adaptive Card or plain-text conventions already used by the adapter.
- **Discord:** channel reply split to Discord limits.
- **Telegram:** escaped Telegram text and message-size splitting.
- **GitHub:** issue/PR comment appropriate to its existing progress lifecycle.
- **Linear:** issue comment using Linear markdown constraints.
- **Twilio:** concise SMS/WhatsApp-safe text without rich formatting.

Each default `step.failed` handler is a no-op unless `extractScheduledRecoveryNotice` succeeds. This avoids duplicate output for ordinary failures, which continue to be rendered by `turn.failed` or `session.failed`.

Suggested meaning, adapted per channel:

```text
AI Gateway free tier rate limit exceeded
Free tier requests on this model are rate-limited.
Retrying automatically in about 42 seconds (attempt 1 of 1).
```

Do not promise an exact wall-clock time; channel delivery and workflow wake-up can add latency. The semantic rule's remediation hint may be included, but wording that instructs the user to retry manually must not appear while an automatic retry is scheduled.

## Slack-specific behavior

Keep Slack parsing calls generic but formatting local. Refactor Slack's current `extractSemanticErrorSummary` to use the shared structural semantic-summary parser; retain `formatSemanticErrorBlock`, `formatSemanticErrorReply`, and the new scheduled-recovery formatter in `public/channels/slack/`.

The first implementation posts a thread reply rather than creating an updateable status message. Successful retry output naturally follows it. Avoid deleting or editing the notice: it remains useful context for the delay, and update bookkeeping would require durable message IDs in adapter state. A later UX iteration may replace the notice with an ephemeral typing status where the channel supports it.

## Observability

Add structured fields to the existing retry warning log:

- semantic error ID;
- recovery attempt and maximum;
- selected delay;
- delay source (`retry-after-seconds`, `retry-after-date`, or `policy-default`);
- session ID and turn ID.

Add attempt telemetry context such as:

```text
eve.retry.reason = semantic-error
eve.retry.semantic_error_id = gateway-free-tier-rate-limited
eve.retry.attempt = 1
```

Do not include raw response headers in logs. Existing `errorId` correlation remains on `step.failed`, and the final exhausted failure receives its own error ID unless the implementation deliberately carries one recovery-operation ID across attempts.

## Implementation sequence

### 1. Current Gateway classification

- Keep the existing 403 `GatewayInvalidRequestError` fixtures as compatibility coverage.
- Add current 429 `GatewayRateLimitError` fixtures with `type: "rate_limit_exceeded"` and `isRetryable: true` in semantic-error, model-call classification, and tool-loop tests.
- Ensure both shapes match `gateway-free-tier-rate-limited`.
- Make the durable policy win over the generic retryable flag so the 429 does not burn short retries before scheduling the meaningful wait.

### 2. Semantic policy and header extraction

- Add and validate the optional recovery policy on semantic rules and summaries.
- Add `Retry-After` extraction/parsing from nested `responseHeaders`.
- Add delay resolution with minimum, cap, and fallback jitter.
- Keep model-call diagnostic extraction free of raw header disclosure.

### 3. Durable recovery state and harness transition

- Add the session-state helper with stale/corrupt-state handling.
- Add the scheduled-recovery branch to the model-call catch.
- Emit only `step.failed`, advance the step index, commit durable prompt history, request turn sleep, and return `next: runStep`.
- Clear recovery state on success and every terminal turn path.
- Add the partial-output guard.

### 4. Shared parsing and channel-local rendering

- Add shared parsers for semantic failure details and scheduled recovery metadata.
- Move only Slack's structural semantic parser to the shared utility; keep all Slack rendering local.
- Add optional `step.failed` handlers and defaults to all built-in channel interfaces.
- Add one formatter and focused default-handler test per channel.

### 5. Documentation and release

- Document `step.failed` in channel event handler references as potentially nonterminal when automatic recovery is scheduled.
- Document that built-in channels may post an automatic-retry notice and that custom `step.failed` handlers replace the default for that event.
- Add a patch changeset for the published `eve` package.

## Validation

### Unit tests

Semantic catalog:

- legacy 403 and current 429 shapes resolve to the same semantic error;
- the free-tier rule exposes the durable policy;
- unrelated Gateway 429s do not acquire that policy;
- malformed recovery policies are rejected by any catalog invariant added.

Header parsing:

- integer-seconds `Retry-After`;
- HTTP-date `Retry-After` with an injected clock;
- missing, negative, fractional, expired-date, overflow, and malformed values;
- configured maximum delay clamps server guidance;
- fallback delay uses bounded jitter;
- headers elsewhere on the cause chain are found structurally.

Recovery state:

- first attempt schedules;
- exhausted attempt does not schedule;
- another turn cannot inherit state;
- another semantic error has an independent budget;
- malformed state is discarded;
- success and terminal settlement clear state.

Harness:

- current 429 emits `step.failed` without `turn.failed`, requests durable sleep, returns `next: runStep`, and advances `stepIndex`;
- legacy 403 follows the same path while retained for compatibility;
- resumed success produces one `turn.completed` and no `turn.failed`;
- resumed failure emits the normal final failure cascade;
- original message and staged attachment refs appear exactly once in persisted history;
- no duplicate `turn.started` or `message.received` is emitted;
- partial assistant/action output disables automatic replay;
- cancellation during sleep settles as `turn.cancelled`;
- task mode preserves its existing behavior;
- ordinary transient 429s retain the short retry loop.

Channels:

- a valid scheduled semantic recovery posts one notice;
- an ordinary `step.failed` posts nothing;
- malformed or unknown recovery metadata posts nothing;
- each channel respects its escaping, splitting, and length constraints;
- a custom `step.failed` handler overrides the built-in default;
- handler failure is swallowed by the existing adapter boundary and does not stop recovery.

### Integration/scenario tests

- Extend the turn workflow test to prove a harness-produced `sleepDurationMs` durably sleeps before the next model step.
- Add an integration model that rejects once with the current Gateway 429 shape and succeeds after retry; assert the complete event sequence and persisted history.
- Add a cancellation-during-recovery integration case using fake or controlled workflow time.
- Add or update a channel fixture eval if CI can deterministically model the 429 → delayed success path; otherwise keep the timing behavior at integration tier and use channel unit tests for rendering.

Run the narrowest relevant checks with tier configs, then:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts <affected-unit-tests>
pnpm --filter eve exec vitest run --config vitest.integration.config.ts <affected-integration-tests>
pnpm fmt
pnpm lint
pnpm typecheck
pnpm guard:invariants
pnpm docs:check
```

## Rollout and safeguards

- Ship with one durable retry only.
- Restrict the first policy to the known Gateway free-tier semantic rule.
- Emit telemetry for scheduled, succeeded, exhausted, cancelled, and ineligible-partial-output outcomes.
- Compare scheduled-to-success rate and actual wait duration before adding policies for other errors.
- If durable retries increase duplicate output or turn duration unexpectedly, remove the rule's `recovery` field; the generic machinery remains dormant and behavior returns to user-driven recovery.

## Follow-up for AI Gateway

Request that the legacy WAF rate-limit path attach `Retry-After` and, where available, `X-RateLimit-*` headers. The exact-limit path already serializes these from its 60-second window state, while legacy WAF 429s intentionally omit them. Once the Gateway provides authoritative timing everywhere, eve's 60-second policy default remains only a compatibility fallback.
