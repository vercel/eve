import type { LanguageModel } from "ai";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { HandleMessageStreamEvent, RuntimeIdentity } from "#protocol/message.js";
import type { CancelSessionResult, SendTurnInput, SessionState } from "#client/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import type {
  EveEvalEventMatch,
  EveEvalInputRequestMatchOptions,
  EveEvalSkillLoadMatchOptions,
  EveEvalSubagentCallMatchOptions,
  EveEvalToolCallMatchOptions,
} from "#evals/match.js";

/** Lifecycle outcome of an eval-observed tool or subagent action. */
export type EveEvalActionStatus = "pending" | "completed" | "failed" | "rejected";

/**
 * One tool call extracted from the captured stream, pairing the
 * `actions.requested` request with its matching `action.result`.
 */
export interface EveEvalToolCall {
  /** Authored tool name (e.g. `"get_weather"`). */
  readonly name: string;
  /** Tool input as requested by the model. */
  readonly input: JsonObject;
  /** Tool output from the matching `action.result`; `undefined` when the call never resolved. */
  readonly output: JsonValue | undefined;
  /** Whether the request is unresolved, completed, failed, or user-rejected. */
  readonly status: EveEvalActionStatus;
  /** Zero-based index of the turn the call happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * One subagent delegation extracted from the captured stream
 * (`subagent.called` / `subagent.started`, joined with `subagent.completed`).
 */
export interface EveEvalSubagentCall {
  /** Runtime-action call id joining this delegation's lifecycle events, when observed. */
  readonly callId?: string;
  /** Durable child session id for local and remote workflow delegations. */
  readonly childSessionId?: string;
  /** Subagent name. */
  readonly name: string;
  /** Remote agent URL for remote delegations (`subagent.called` remote metadata). */
  readonly remoteUrl?: string;
  /** Output from the matching `subagent.completed` event; `undefined` when the call never completed. */
  readonly output?: JsonValue;
  /** Whether the delegation is unresolved, completed, failed, or rejected. */
  readonly status: EveEvalActionStatus;
  /** Zero-based index of the turn the delegation happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * Execution facts the runner extracts from a completed session's stream events.
 */
export interface EveEvalDerivedFacts {
  readonly toolCalls: readonly EveEvalToolCall[];
  readonly toolCallCount: number;
  readonly subagentCalls: readonly EveEvalSubagentCall[];
  readonly subagentCallCount: number;
  /** Every HITL input request raised during the run (`input.requested`). */
  readonly inputRequests: readonly InputRequest[];
  /** True when the run ended parked on unanswered HITL input requests. */
  readonly parked: boolean;
  readonly messageCount: number;
  readonly reasoningBlockCount: number;
  readonly failureCode?: string;
}

/**
 * Captured event stream and facts for one session involved in an eval.
 */
export interface EveEvalSessionResult {
  readonly derived: EveEvalDerivedFacts;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly primary: boolean;
  readonly sessionId?: string;
  readonly state: SessionState;
}

/**
 * Full result of executing one eval against an eve agent.
 */
export interface EveEvalTaskResult {
  /**
   * The final turn's structured data when present, otherwise its last assistant
   * message. Retained for reporters and artifacts that log one output value.
   */
  output: unknown;
  /** The agent's last assistant message, or null when none was produced. */
  readonly finalMessage: string | null;
  readonly sessionId?: string;
  /**
   * How the run's final turn ended: `"completed"` (session finished),
   * `"failed"` (terminal failure), or `"waiting"` (parked for the next
   * user message).
   */
  readonly status: "completed" | "failed" | "waiting";
  /** The captured stream events from the run. */
  readonly events: readonly HandleMessageStreamEvent[];
  /** Lines written through `t.log` while the eval ran. */
  readonly logs?: readonly string[];
  /** Facts extracted from the stream (tool calls, message counts, etc.). */
  readonly derived: EveEvalDerivedFacts;
  /** Per-session event streams captured while executing this eval. */
  readonly sessions?: readonly EveEvalSessionResult[];
  /**
   * Runtime identity metadata captured from the `session.started` stream event.
   * Present when the eve server populates the event with its runtime metadata.
   */
  readonly runtimeIdentity?: RuntimeIdentity;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * How a failing assertion affects the verdict. A `"gate"` is a hard
 * assertion: missing it fails the eval. A `"soft"` assertion is tracked
 * data that only fails the eval under `eve eval --strict` (and only when it
 * carries a threshold).
 */
export type AssertionSeverity = "gate" | "soft";

/**
 * A value-level assertion produced by the builders in `eve/evals/expect`
 * (e.g. `includes`, `equals`, `similarity`) and applied to an explicit value
 * via `t.check(value, assertion)`. Boolean assertions score exactly 0 or 1.
 *
 * The chainable `gate`/`soft`/`atLeast` return a new assertion with the
 * severity or threshold overridden, so the threshold rides on the assertion
 * itself rather than a detached map.
 */
export interface Assertion {
  readonly name: string;
  readonly severity: AssertionSeverity;
  /** Minimum passing score. `undefined` on a soft assertion = tracked only. */
  readonly threshold?: number;
  score(value: unknown): number | Promise<number>;
  gate(threshold?: number): Assertion;
  soft(threshold?: number): Assertion;
  atLeast(threshold: number): Assertion;
}

/**
 * Handle to a recorded assertion, returned by every `t` assertion method.
 * Chain `gate`/`soft`/`atLeast` to override the recorded severity or
 * threshold. Recorded assertions are finalized by the runner; use `t.require`
 * or a `require*` lookup when later control flow depends on a passing result.
 */
export interface AssertionHandle {
  gate(threshold?: number): this;
  soft(threshold?: number): this;
  atLeast(threshold: number): this;
}

/**
 * The recorded outcome of one assertion, consumed by the verdict, reporters,
 * and artifacts. A boolean assertion has `score` 0 or 1.
 */
export interface AssertionResult {
  readonly name: string;
  readonly score: number;
  readonly severity: AssertionSeverity;
  readonly threshold?: number;
  readonly passed: boolean;
  /** Human-readable failure detail, shown in console output and artifacts. */
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Recorded assertions shared by aggregate, session, and turn scopes. */
export interface EveEvalAssertions {
  succeeded(): AssertionHandle;
  parked(): AssertionHandle;
  messageIncludes(token: string | RegExp): AssertionHandle;
  calledTool(name: string, options?: EveEvalToolCallMatchOptions): AssertionHandle;
  /** Sugar for `calledTool("load_skill", { input: { skill }, ... })`. */
  loadedSkill(skill: string, options?: EveEvalSkillLoadMatchOptions): AssertionHandle;
  notCalledTool(name: string): AssertionHandle;
  /** Asserts that tool requests appeared in order, allowing unrelated requests between them. */
  toolOrder(names: readonly string[]): AssertionHandle;
  usedNoTools(): AssertionHandle;
  maxToolCalls(max: number): AssertionHandle;
  calledSubagent(name: string, options?: EveEvalSubagentCallMatchOptions): AssertionHandle;
  noFailedActions(): AssertionHandle;
  event<TType extends HandleMessageStreamEvent["type"]>(
    type: TType,
    options?: Omit<Extract<EveEvalEventMatch, { type: TType }>, "type">,
  ): AssertionHandle;
  notEvent<TType extends HandleMessageStreamEvent["type"]>(
    type: TType,
    options?: Omit<Extract<EveEvalEventMatch, { type: TType }>, "type" | "count">,
  ): AssertionHandle;
  eventOrder(matchers: readonly EveEvalEventMatch[]): AssertionHandle;
  eventsSatisfy(
    label: string,
    predicate: (events: readonly HandleMessageStreamEvent[]) => boolean,
  ): AssertionHandle;
}

/** Assertions over the final output captured by one session or immutable turn. */
export interface EveEvalOutputAssertions {
  outputEquals(value: unknown): AssertionHandle;
  outputMatches(schema: StandardSchemaV1): AssertionHandle;
}

/** Typed stream event returned by {@link EveEvalLiveTurn.waitForEvent}. */
export type EveEvalStreamEvent<
  TType extends HandleMessageStreamEvent["type"] = HandleMessageStreamEvent["type"],
> = Extract<HandleMessageStreamEvent, { type: TType }>;

/** Matcher options for waiting until one live turn emits a specific event. */
export type EveEvalWaitForEventOptions<TType extends HandleMessageStreamEvent["type"]> = Omit<
  Extract<EveEvalEventMatch, { type: TType }>,
  "count" | "type"
>;

/**
 * One accepted turn whose event stream is still in progress.
 *
 * The handle owns the stream consumer: event waiters observe its buffer and
 * {@link result} settles and records that same stream exactly once.
 */
export interface EveEvalLiveTurn {
  /** Events observed on this turn so far. */
  readonly events: readonly HandleMessageStreamEvent[];
  /** Session driver that started or owns this turn. */
  readonly session: EveEvalSession;
  /** Durable session id available as soon as the turn is accepted or attached. */
  readonly sessionId: string;
  /** Request cooperative cancellation of this turn's session. */
  cancel(): Promise<CancelSessionResult>;
  /** Wait for the turn boundary and return the recorded immutable result. */
  result(): Promise<EveEvalTurn>;
  /** Wait until the live stream emits one typed event matching `options`. */
  waitForEvent<TType extends HandleMessageStreamEvent["type"]>(
    type: TType,
    options?: EveEvalWaitForEventOptions<TType>,
  ): Promise<EveEvalStreamEvent<TType>>;
}

/** Operations and state shared by the primary eval context and independent sessions. */
export interface EveEvalSessionDriver {
  /** All events observed on this session so far. */
  readonly events: readonly HandleMessageStreamEvent[];
  /** Input requests left pending by the last parked turn. */
  readonly pendingInputRequests: readonly InputRequest[];
  /** Serializable cursor for resuming this session. */
  readonly state: SessionState;
  /** eve session id after the first successful send. */
  readonly sessionId: string | undefined;
  /** Request cooperative cancellation of this session's active turn. */
  cancel(): Promise<CancelSessionResult>;
  /** Require exactly one pending input request matching `filter`, or abort dependent control flow. */
  requireInputRequest(filter?: EveEvalInputRequestMatchOptions): InputRequest;
  /** Resolve specific pending requests and run the resumed turn. */
  respond(...responses: InputResponse[]): Promise<EveEvalTurn>;
  /** Resolve every pending request with the same option id. */
  respondAll(optionId: string): Promise<EveEvalTurn>;
  /** Send one turn through this session. */
  send(input: SendTurnInput): Promise<EveEvalTurn>;
  /** Start one turn and return as soon as its session is accepted. */
  start(input: SendTurnInput): Promise<EveEvalLiveTurn>;
  /** Send one text turn with a local file attached as a data URL. */
  sendFile(text: string, filePath: string, mediaType?: string): Promise<EveEvalTurn>;
}

/** Driver for one independent session, exposed by `t.newSession()` and target attachment helpers. */
export interface EveEvalSession
  extends EveEvalSessionDriver, EveEvalAssertions, EveEvalOutputAssertions {}

/**
 * One completed eval-driver turn.
 */
export interface EveEvalTurn extends EveEvalAssertions, EveEvalOutputAssertions {
  readonly data: unknown;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
  readonly toolCalls: readonly EveEvalToolCall[];
  /** Require exactly one matching tool call, record a gate, and return it for dependent checks. */
  requireToolCall(
    name: string,
    options?: Omit<EveEvalToolCallMatchOptions, "count">,
  ): EveEvalToolCall;
  expectOk(): this;
}

// ---------------------------------------------------------------------------
// Judge (LLM-as-judge)
// ---------------------------------------------------------------------------

/**
 * The judge model used by `t.judge.*` assertions, configured per-eval or as
 * the run-wide default in `evals.config.ts`. Only ever used for scoring; it
 * never changes the agent under test. String model ids route through the
 * Vercel AI Gateway; provider model instances run directly.
 */
export interface EveEvalJudgeConfig {
  readonly model: LanguageModel;
  readonly modelOptions?: AgentModelOptionsDefinition;
}

/**
 * Per-call options for `t.judge.autoevals.*` assertions.
 */
export interface JudgeOpts {
  /** Value to grade. Defaults to the final assistant message (`t.reply`). */
  readonly on?: unknown;
  /** Judge model for this call only; overrides the eval/config judge model. */
  readonly model?: LanguageModel;
  readonly modelOptions?: AgentModelOptionsDefinition;
}

/**
 * Braintrust autoevals graders, bound to the resolved judge model. The grader
 * family is named so its semantics are explicit: `factuality`'s consistency
 * buckets and `closedQA`'s yes/no grading are autoevals' behavior, not eve's.
 * These are eve-owned wrappers, not the raw library.
 */
export interface AutoevalsJudges {
  factuality(expected: string, opts?: JudgeOpts): AssertionHandle;
  summarizes(expected: string, opts?: JudgeOpts): AssertionHandle;
  closedQA(criteria: string, opts?: JudgeOpts): AssertionHandle;
  sql(expected: string, opts?: JudgeOpts): AssertionHandle;
}

/**
 * Model-backed assertion namespaces on `t.judge`. A future non-autoevals
 * engine would slot in as a sibling of `autoevals`.
 */
export interface JudgeContext {
  readonly autoevals: AutoevalsJudges;
}

/**
 * The single context passed to an eval's `test(t)` function. It drives the
 * primary session, carries the run-level
 * and value-level assertion vocabulary, and exposes `judge` for LLM-as-judge.
 *
 * Scoped assertions (`succeeded`, `calledTool`, …) record an entry evaluated
 * after the test body; `check`, `require`, and `judge` evaluate explicit values.
 */
export interface EveEvalContext extends EveEvalSessionDriver, EveEvalAssertions {
  /** Eval timeout signal. */
  readonly signal: AbortSignal;
  /** Current target under test. */
  readonly target: EveEvalTargetHandle;
  /** The primary session's last assistant message, or null. */
  readonly reply: string | null;
  /** Structured eval log hook. */
  log(message: string): void;
  /** Pause the eval task, defaulting to 1 second, while respecting the eval timeout signal. */
  sleep(ms?: number): Promise<void>;
  /** Create an additional independent session against the same target. */
  newSession(): EveEvalSession;

  /** Apply a value-level assertion (from `eve/evals/expect`) to a value. */
  check(value: unknown, assertion: Assertion): AssertionHandle;
  /** Record an immediate gate and abort dependent control flow when it fails. */
  require<T>(value: T, assertion: Assertion): Promise<T>;
  /** Mark this eval as intentionally skipped and stop executing its test body. */
  skip(reason: string): never;

  /** LLM-as-judge assertions, bound to the resolved judge model. */
  readonly judge: JudgeContext;
}

/**
 * Describes the eve server an eval runs against.
 */
export interface EveEvalTarget {
  /**
   * `"local"` for a dev server the runner starts in-process, `"remote"` for
   * a deployed instance addressed by `--url`.
   */
  readonly kind: "local" | "remote";
  /** Base HTTP URL the eval client connects to and sends message requests. */
  readonly url: string;
  /** Capabilities discovered from the live target's info route. */
  readonly capabilities: EveEvalTargetCapabilities;
}

export interface EveEvalTargetCapabilities {
  readonly devRoutes: boolean;
}

export interface EveEvalScheduleDispatchResult {
  readonly scheduleId: string;
  readonly sessionIds: readonly string[];
}

/**
 * Live target handle exposed to eval runs.
 */
export interface EveEvalTargetHandle extends EveEvalTarget {
  /** Dispatch a dev-only authored schedule. Requires a target with dev routes enabled. */
  dispatchSchedule(scheduleId: string): Promise<EveEvalScheduleDispatchResult>;
  /** Authenticated fetch against the target base URL. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Attach to a pre-existing session and consume one turn boundary.
   *
   * When that boundary is `session.waiting`, the attached session recovers
   * the current continuation token from the stream, so `session.send(...)`
   * and `session.respond(...)` continue the same durable session.
   */
  attachSession(
    sessionId: string,
    opts?: { readonly startIndex?: number },
  ): Promise<EveEvalSession>;
  /**
   * Observe one in-progress turn from a session created outside the eval.
   * The returned live-turn handle starts consuming immediately and owns the
   * stream through its next turn boundary.
   */
  watchTurn(sessionId: string, opts?: { readonly startIndex?: number }): EveEvalLiveTurn;
}

// ---------------------------------------------------------------------------
// Eval definition types
// ---------------------------------------------------------------------------

/**
 * Shared fields between the user-facing input and the validated eval.
 *
 * Eval identity (`id`) is derived from the `evals/<path>.eval.ts` file
 * path by the discovery layer; it is not authored on the input.
 */
interface EveEvalBase {
  readonly description?: string;
  /**
   * Judge model for this eval's `t.judge.*` assertions. Optional: when
   * omitted, judge assertions fall back to the `judge` declared in
   * `evals.config.ts`. Only used for scoring; never changes the agent
   * under test.
   */
  readonly judge?: EveEvalJudgeConfig;
  readonly timeoutMs?: number;
  /** Used by `--tag` filtering. */
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reporters?: readonly EvalReporter[];
}

/**
 * Complete top-level key set accepted by {@link defineEval}, used to reject
 * unknown authored keys.
 */
export interface EveEvalInputFields extends EveEvalBase {
  readonly test?: (t: EveEvalContext) => void | Promise<void>;
}

/**
 * Full eval input passed to `defineEval()`.
 *
 * Each eval file is exactly one case: an imperative `test(t)` function that
 * drives the agent and asserts on what it produced. Eval identity is derived
 * from the file path, so authors do not specify an `id` or `name`.
 */
export interface EveEvalInput extends EveEvalBase {
  /** Imperative interaction-and-assertion script. */
  test(t: EveEvalContext): void | Promise<void>;
}

/**
 * Eval returned by `defineEval()`. Carries no `id` yet: discovery stamps
 * the path-derived id at import time to produce a full {@link EveEval}. The
 * `_tag` literal (`"EveEval"`) brands the value so discovery and the runner
 * can recognize a defined eval.
 */
export type EveEvalDefinition = EveEvalInput & {
  readonly _tag: "EveEval";
};

/**
 * Validated eval consumed by the runner and reporters. The `id` is the
 * path-derived slug attached by discovery (e.g. `evals/weather.eval.ts` →
 * `"weather"`, `evals/runtime/multi-turn.eval.ts` → `"runtime/multi-turn"`).
 * Files that default-export an array of evals derive
 * `<file-id>/<zero-padded index>` ids (e.g. `"weather/0000"`).
 */
export type EveEval = EveEvalDefinition & {
  readonly id: string;
};

/**
 * Per-eval outcome computed by the runner:
 *
 * - `"passed"`  — no execution error, every gate held, every soft threshold met
 * - `"failed"`  — a gate assertion failed or execution errored (timeout, transport, thrown task)
 * - `"scored"`  — every gate held but a soft assertion fell below its threshold
 * - `"skipped"` — the test body intentionally called `t.skip(reason)`
 */
export type EveEvalVerdict = "passed" | "failed" | "scored" | "skipped";

/**
 * Result of executing and asserting one eval.
 *
 * `id` is the path-derived eval id
 * (e.g. `evals/weather.eval.ts` → `"weather"`).
 */
export interface EveEvalResult {
  readonly id: string;
  readonly result: EveEvalTaskResult;
  /** Every assertion recorded by the eval's `test(t)`, in record order. */
  readonly assertions: readonly AssertionResult[];
  /** Per-eval verdict; see {@link EveEvalVerdict}. */
  readonly verdict: EveEvalVerdict;
  readonly error?: string;
  /** Why the eval intentionally skipped, present only for a `"skipped"` verdict. */
  readonly skipReason?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

/**
 * Aggregated outcome of one `eve eval` run across every executed eval.
 */
export interface EveEvalRunSummary {
  readonly target: EveEvalTarget;
  readonly results: readonly EveEvalResult[];
  readonly startedAt: string;
  readonly completedAt: string;
  /** Evals with verdict `"passed"`. */
  readonly passed: number;
  /** Evals with verdict `"failed"` (gate failures and execution errors). */
  readonly failed: number;
  /** Evals with verdict `"scored"` (below-threshold soft assertions only). */
  readonly scored: number;
  /** Evals intentionally skipped by their test body. */
  readonly skipped: number;
  /** The execution-error subset of `failed` (timeouts, connection failures, exceptions). */
  readonly errored: number;
}

// ---------------------------------------------------------------------------
// Eval run configuration
// ---------------------------------------------------------------------------

/**
 * Run-wide eval configuration authored in `evals.config.ts`.
 *
 * Exactly one `evals.config.ts` is required at the root of the `evals/`
 * directory; it supplies the defaults every eval in the run shares.
 */
export interface EveEvalConfigInput {
  /**
   * Default judge model for `t.judge.*` assertions across every eval.
   * Optional: evals that use no judge need not set it, and individual evals
   * may override it with their own `judge`. Only ever used for scoring.
   */
  readonly judge?: EveEvalJudgeConfig;
  /**
   * Reporters that observe every eval in the run (e.g. a shared
   * `Braintrust()` experiment). Suppressed by `eve eval --skip-report`.
   */
  readonly reporters?: readonly EvalReporter[];
  /**
   * Default maximum number of evals executing at once. Must be a positive
   * integer. `eve eval --max-concurrency` overrides it; defaults to 8 when
   * neither is set.
   */
  readonly maxConcurrency?: number;
  /**
   * Default per-eval timeout in milliseconds. An eval's own `timeoutMs`
   * overrides it, and `eve eval --timeout` overrides both.
   */
  readonly timeoutMs?: number;
}

/**
 * Validated eval run configuration returned by `defineEvalConfig()`. The
 * `_tag` literal brands the value so discovery can recognize it.
 */
export type EveEvalConfig = EveEvalConfigInput & {
  readonly _tag: "EveEvalConfig";
};
