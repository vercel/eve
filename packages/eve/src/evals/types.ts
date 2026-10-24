import type { Delivery } from "#shared/delivery.js";
import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/session-view.js";
import type { RequestStatus } from "#protocol/session-projection/request-status.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { DecisionModel } from "#ai/decision-types.js";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { ClientAgentSession } from "#client/agent-session.js";
import type { RuntimeIdentity, TraceContext } from "#protocol/session-events/families/session.js";
import type {
  ClientSessionState,
  CreateSessionOptions,
  SendTurnInput,
  SendTurnOptions,
  RespondTurnOptions,
} from "#client/types.js";
import type { Answer } from "#shared/input.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";
import type {
  EveEvalEventMatch,
  EveEvalInteractionMatchOptions,
  EveEvalSkillLoadMatchOptions,
  EveEvalSubagentCallMatchOptions,
  EveEvalToolCallMatchOptions,
} from "#evals/match.js";

/** Lifecycle outcome of an eval-observed tool action. */
export type EveEvalActionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "rejected"
  | "interrupted"
  | "abandoned";

/**
 * One tool call extracted from the captured stream, pairing the
 * `call.requested` request with its matching `call.settled`.
 */
export interface EveEvalToolCall {
  /** The call's id, as its `call.*` facts name it. */
  readonly callId: string;
  /** Authored tool name (e.g. `"get_weather"`). */
  readonly name: string;
  /** Tool input as requested by the model. */
  readonly input: JsonObject;
  /** Inline output from `call.settled`; absent when unresolved or only a reference was recorded. */
  readonly output: JsonValue | undefined;
  /** Pending until settled, then the call's explicit outcome. */
  readonly status: EveEvalActionStatus;
  /** Zero-based index of the turn the call happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * One skill call extracted from the captured stream, pairing its `call.requested`
 * capability with its matching `call.settled`.
 */
export interface EveEvalSkillLoad {
  /** The loaded skill's name. */
  readonly skill: string;
  /** The skill's instructions; `undefined` when the load never resolved. */
  readonly output: JsonValue | undefined;
  readonly status: EveEvalActionStatus;
  /** Zero-based index of the turn the load happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * One call served by an agent task: its `call.started {taskId}`, joined with
 * `call.settled`, the task's single `task.started`, and its child-session link.
 */
export interface EveEvalSubagentCall {
  /** The agent tool call's id. */
  readonly callId?: string;
  /** The agent's session id, shared by every call to one task; absent if it never opened. */
  readonly childSessionId?: string;
  /** Subagent name. */
  readonly name: string;
  /** Output from `call.settled`, resolving shared replies; absent until it completes. */
  readonly output?: JsonValue;
  /** Pending until this call settles, then the call's explicit outcome. */
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
  readonly skillLoads: readonly EveEvalSkillLoad[];
  readonly subagentCalls: readonly EveEvalSubagentCall[];
  readonly subagentCallCount: number;
  /** Every HITL input request raised during the run (`interaction.opened`). */
  readonly interactions: readonly Interaction[];
  /** True when the run ended parked on unanswered HITL input requests. */
  readonly parked: boolean;
  readonly messageCount: number;
  readonly reasoningBlockCount: number;
  /**
   * Distinct model ids from `model.started`: in first-use order for one session, and in session
   * order for an eval. Includes compaction summaries. Covers only captured sessions; a delegated
   * agent's models appear only when the eval captures its session. Provider-internal routing
   * calls without an eve model lifecycle are not included.
   */
  readonly models: readonly string[];
  /**
   * Sum of the captured session's `usage.recorded` facts through this turn: its own model calls,
   * compaction summaries, and delegated spend recorded on calls. A turn reports the session's
   * total so far, not only that turn's spend. For an eval, each captured session counts once, by
   * the capture whose latest `usage.recorded` is latest in time, except sessions another captured
   * session opened, whose spend is attributed to that parent's calls. Absent when a counted session
   * reported no usage; `costUsd` is absent when a counted session reported no cost.
   */
  readonly usage?: TokenUsage;
  readonly failureCode?: string;
}

/**
 * Captured event stream and facts for one session involved in an eval.
 */
export interface EveEvalSessionResult {
  readonly view: SessionView;
  readonly derived: EveEvalDerivedFacts;
  readonly events: readonly SessionStreamEvent[];
  readonly primary: boolean;
  readonly sessionId?: string;
  readonly state: ClientSessionState | undefined;
  /** Distinct trace contexts observed for this session, in stream order. */
  readonly traceContexts: readonly TraceContext[];
}

/** Trace context attributed to one session involved in an eval. */
export interface EveEvalTraceContext extends TraceContext {
  readonly primary: boolean;
  readonly sessionId: string;
}

/**
 * Full result of executing one eval against an eve agent.
 */
export interface EveEvalTaskResult {
  /** The last observed turn's session view; absent when no turn was read. */
  readonly view?: SessionView;
  /** Whether the session owning the last observed turn ended. */
  readonly sessionEnded: boolean;
  /** The last observed turn's structured output, when present. */
  readonly data: unknown;
  /** The last observed turn's reply text, when present. */
  readonly reply: string | undefined;
  /** Present when the read observed its accepted delivery's settlement. */
  readonly outcome?: DeliveryOutcome;
  readonly error?: ErrorInfo;
  /** The primary captured session ID; other sessions are listed in sessions. */
  readonly sessionId?: string;
  /**
   * The last observed request's status, independent of whether its session ended.
   */
  readonly status: RequestStatus | "working";
  /** The captured stream events from the run. */
  readonly events: readonly SessionStreamEvent[];
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
  /** Distinct trace contexts observed across every captured session. */
  readonly traceContexts: readonly EveEvalTraceContext[];
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
 * A rich value-assertion evaluation. Built-in assertions use this to retain a
 * concise failure reason and structured evidence alongside the numeric score.
 */
export interface AssertionEvaluation {
  /** Normalized 0–1 score. */
  readonly score: number;
  /** Concise human-readable reason, shown when the assertion fails. */
  readonly message?: string;
  /** Structured diagnostic evidence retained by artifacts and reporters. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A score from 0 to 1, or an evaluation carrying one, accepted by `t.score`; may be a promise. */
export type ScoreInput = number | AssertionEvaluation | Promise<number | AssertionEvaluation>;

/**
 * A value-level assertion produced by the builders in `eve/evals/expect`
 * (e.g. `includes`, `equals`, `similarity`) and applied to an explicit value
 * via `t.check(value, assertion)`. Boolean assertions score exactly 0 or 1.
 *
 * The chainable `gate`/`soft`/`atLeast` return a new assertion with the
 * severity or threshold overridden.
 */
export interface Assertion {
  readonly name: string;
  readonly severity: AssertionSeverity;
  /** Minimum passing score. `undefined` on a soft assertion = tracked only. */
  readonly threshold?: number;
  score(value: unknown): number | Promise<number>;
  /** Rich evaluation used by `t.check` and `t.require`; custom assertions may omit it. */
  evaluate?(value: unknown): AssertionEvaluation | Promise<AssertionEvaluation>;
  gate(threshold?: number): Assertion;
  soft(threshold?: number): Assertion;
  atLeast(threshold: number): Assertion;
}

/**
 * Handle to a recorded assertion, returned by every `t` assertion method.
 * Chain `gate`/`soft`/`atLeast` to override the recorded severity or threshold,
 * and `label` to distinguish repeated assertion families. Recorded assertions
 * are finalized by the runner; use `t.require` or a `require*` lookup when
 * later control flow depends on a passing result.
 */
export interface AssertionHandle {
  gate(threshold?: number): this;
  soft(threshold?: number): this;
  atLeast(threshold: number): this;
  /** Sets this entry's stable `key` and appends the label to its display name. */
  label(label: string): this;
}

/**
 * The recorded outcome of one assertion or `t.score`, consumed by the verdict,
 * reporters, and artifacts. `score` is the measurement and a rule does not
 * change it; `threshold` and `passed` describe the rule and are absent when
 * none applies. A boolean assertion has `score` 0 or 1.
 */
export interface AssertionResult {
  /** Display name, e.g. `judge.boolean [citation]`. */
  readonly name: string;
  /** Stable identifier set by `.label(key)`; absent for unlabeled assertions. */
  readonly key?: string;
  /** The measurement; absent when the scorer threw. */
  readonly score?: number;
  readonly severity: AssertionSeverity;
  /** Effective minimum passing score (a gate defaults to 1); absent when no rule applies. */
  readonly threshold?: number;
  /** Verdict of the acceptance rule; absent when no rule applies. */
  readonly passed?: boolean;
  /** Whether the scorer threw; an errored entry is always a failed outcome. */
  readonly errored: boolean;
  /** Human-readable failure detail, shown in console output and artifacts. */
  readonly message?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Recorded assertions shared by aggregate, session, and turn scopes. */
export interface EveEvalAssertions {
  succeeded(): AssertionHandle;
  awaitingInput(): AssertionHandle;
  messageIncludes(token: string | RegExp): AssertionHandle;
  calledTool(name: string, options?: EveEvalToolCallMatchOptions): AssertionHandle;
  /** Asserts a completed load of `skill`, constrained like `calledTool`. */
  calledSkill(skill: string, options?: EveEvalSkillLoadMatchOptions): AssertionHandle;
  notCalledTool(name: string): AssertionHandle;
  /** Asserts that tool requests appeared in order, allowing unrelated requests between them. */
  toolOrder(names: readonly string[]): AssertionHandle;
  usedNoTools(): AssertionHandle;
  maxToolCalls(max: number): AssertionHandle;
  calledAgent(name: string, options?: EveEvalSubagentCallMatchOptions): AssertionHandle;
  noFailedCalls(): AssertionHandle;
  event<TType extends SessionStreamEvent["type"]>(
    type: TType,
    options?: Omit<Extract<EveEvalEventMatch, { type: TType }>, "type">,
  ): AssertionHandle;
  notEvent<TType extends SessionStreamEvent["type"]>(
    type: TType,
    options?: Omit<Extract<EveEvalEventMatch, { type: TType }>, "type" | "count">,
  ): AssertionHandle;
  eventOrder(matchers: readonly EveEvalEventMatch[]): AssertionHandle;
  eventsSatisfy(
    label: string,
    predicate: (events: readonly SessionStreamEvent[]) => boolean,
  ): AssertionHandle;
}

/** Assertions over the final output captured by one session or immutable turn. */
export interface EveEvalOutputAssertions {
  outputEquals(value: unknown): AssertionHandle;
  outputMatches(schema: StandardSchemaV1): AssertionHandle;
}

/** Typed stream event returned by {@link EveEvalLiveTurn.waitForEvent}. */
export type EveEvalStreamEvent<
  TType extends SessionStreamEvent["type"] = SessionStreamEvent["type"],
> = Extract<SessionStreamEvent, { type: TType }>;

/** Matcher options for waiting until one live turn emits a specific event. */
export type EveEvalWaitForEventOptions<TType extends SessionStreamEvent["type"]> = Omit<
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
  readonly view: SessionView;
  /** Events observed on this turn so far. */
  readonly events: readonly SessionStreamEvent[];
  /** Session driver that started or owns this turn. */
  readonly session: EveEvalSession;
  /** Durable session id available as soon as the turn is accepted or attached. */
  readonly sessionId: string;
  /** Request cooperative cancellation of this turn's session. */
  cancel(): Promise<Delivery>;
  /** Wait for the turn boundary and return the recorded immutable result. */
  result(): Promise<EveEvalTurn>;
  /** Wait until the live stream emits one typed event matching `options`. */
  waitForEvent<TType extends SessionStreamEvent["type"]>(
    type: TType,
    options?: EveEvalWaitForEventOptions<TType>,
  ): Promise<EveEvalStreamEvent<TType>>;
  /**
   * Wait until a call to the tool named `name` settles, matching `options`. Without a `status`,
   * any settled outcome matches.
   */
  waitForToolCall(
    name: string,
    options?: Omit<EveEvalToolCallMatchOptions, "count">,
  ): Promise<EveEvalToolCall>;
}

/** Operations and state belonging to one accepted session. */
interface EveEvalSessionDriver {
  /** All events observed on this session so far. */
  readonly events: readonly SessionStreamEvent[];
  /**
   * User and assistant messages observed on this session in turn order. Pass
   * this to a judge's `on` option to grade the complete conversation.
   */
  readonly transcript: string;
  /** Input requests left pending by the last parked turn. */
  readonly pendingInteractions: readonly Interaction[];
  /** Serializable cursor for resuming this session. */
  readonly state: ClientSessionState;
  /** Fixed session ID, available without reading the stream. */
  readonly id: string;
  /** Read and record the next turn from this session's current cursor. */
  nextTurn(options?: EveEvalWatchOptions): Promise<EveEvalTurn>;
  /** Start consuming from this session's current cursor and return its live-turn handle. */
  watch(options?: EveEvalWatchOptions): EveEvalLiveTurn;
  /** Request cooperative cancellation of this session's active turn. */
  cancel(): Promise<Delivery>;
  /**
   * Compact this session's history between turns and wait for it to finish.
   * Returns the compaction's events through its `context.settled`; throws when the
   * session is no longer active.
   */
  compact(): Promise<EveEvalTurn>;
  /** Require exactly one pending input request matching `filter`, or abort dependent control flow. */
  requireInteraction(filter?: EveEvalInteractionMatchOptions): Interaction;
  /** Resolve specific pending requests and run the resumed turn. */
  respond(responses: readonly Answer[], options?: RespondTurnOptions): Promise<EveEvalTurn>;
  /** Start a response turn without waiting for its boundary. */
  startRespond(
    responses: readonly Answer[],
    options?: RespondTurnOptions,
  ): Promise<EveEvalLiveTurn>;
  /** Resolve every pending request with the same option id. */
  respondAll(optionId: string): Promise<EveEvalTurn>;
  /** Send one turn through this session. */
  send(message: SendTurnInput["message"], options?: SendTurnOptions): Promise<EveEvalTurn>;
  /** Start one text turn and return as soon as its session is accepted. */
  start(message: string, options?: SendTurnOptions): Promise<EveEvalLiveTurn>;
  /** Send one text turn with a local file attached as a data URL. */
  sendFile(text: string, filePath: string, mediaType?: string): Promise<EveEvalTurn>;
  /**
   * The session an agent run opened, as this session's stream announced it with
   * `child.opened`. Its `stream()` follows the child through this parent session
   * with the eval client's credentials, and stops with the eval unless given a `signal`.
   */
  agent(opened: Extract<SessionStreamEvent, { type: "child.opened" }>): EveEvalAgentSession;
}

/** A session an agent run opened, reached through the parent eval session. */
export type EveEvalAgentSession = Pick<ClientAgentSession, "name" | "id" | "stream" | "taskId">;

/** One accepted session, exposed by `t.session()`, turns, and target attachment helpers. */
export interface EveEvalSession
  extends EveEvalSessionDriver, EveEvalAssertions, EveEvalOutputAssertions {
  readonly view: SessionView;
}

/**
 * One completed eval-driver turn.
 */
export interface EveEvalTurn extends EveEvalAssertions, EveEvalOutputAssertions {
  readonly view: SessionView;
  readonly sessionEnded: boolean;
  readonly data: unknown;
  readonly events: readonly SessionStreamEvent[];
  readonly interactions: readonly Interaction[];
  readonly reply: string | undefined;
  /** A watch may stop before a delivery settles, so its outcome can be absent. */
  readonly outcome?: DeliveryOutcome;
  readonly error?: ErrorInfo;
  /** Session that owns this turn; use it for follow-up messages. */
  readonly session: EveEvalSession;
  readonly sessionId: string;
  readonly status: RequestStatus | "working";
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

/** Decision settings used only for scoring, independently of the agent under test. */
export interface EveEvalJudgeConfig {
  /** Decision model ID or instance. Defaults to the model used by `eve/ai` decide. */
  readonly model?: DecisionModel;
  /** Judge calls carry provider options only; eve places no prompt-cache breakpoints on them. */
  readonly modelOptions?: Pick<AgentModelOptionsDefinition, "providerOptions">;
}

/** JSON content accepted as decision state, instructions, or rubric descriptions. */
export type JudgeInput = string | JsonObject | readonly JsonValue[];

/** A boolean judgment, ordered rubric, or categorical judgment with an expected option. */
export type JudgeQuestion =
  | {
      readonly type: "boolean";
      readonly instructions: JudgeInput;
      readonly criteria?: { readonly true?: JudgeInput | null; readonly false?: JudgeInput | null };
    }
  | {
      readonly type: "score";
      readonly instructions: JudgeInput;
      readonly criteria: readonly (JudgeInput | null)[];
    }
  | {
      readonly type: "choice";
      readonly instructions: JudgeInput;
      readonly criteria: Readonly<Record<string, JudgeInput | null>>;
      readonly expected: string;
    };

/** Restricts a choice expectation to one of its authored option keys. */
export type JudgeQuestionConstraint<Q extends JudgeQuestion> = Q extends { type: "choice" }
  ? { readonly expected: NoInfer<Extract<keyof Q["criteria"], string>> }
  : unknown;

/** Named judgments decided together against one shared state. */
export interface JudgeBatch<Questions extends Record<string, JudgeQuestion>> {
  /** Replaces the default `{ input, output }` state when supplied. */
  readonly state?: JudgeInput;
  readonly questions: Questions & {
    readonly [Key in keyof Questions]: JudgeQuestionConstraint<Questions[Key]>;
  };
}

/** Per-call settings override the resolved eval/project judge settings. */
export interface JudgeOpts extends EveEvalJudgeConfig {
  /** JSON value to grade instead of the latest settled turn's assistant message. */
  readonly on?: JsonValue;
}

/** Model-backed assertions. Calls start immediately and return non-awaitable handles. */
export interface JudgeContext {
  (criteria: string, opts?: JudgeOpts): AssertionHandle;
  <const Q extends JudgeQuestion>(
    question: Q & JudgeQuestionConstraint<Q>,
    opts?: JudgeOpts,
  ): AssertionHandle;
  <const Questions extends Record<string, JudgeQuestion>>(
    batch: JudgeBatch<Questions>,
    opts?: EveEvalJudgeConfig,
  ): { readonly [Key in keyof Questions]: AssertionHandle };
}

/**
 * The context passed to `test(t)`. Creates independent sessions and carries
 * run-level assertions, value-level assertions, and model-backed judges.
 *
 * Scoped assertions (`succeeded`, `calledTool`, …) record an entry evaluated
 * after the test body; `check`, `require`, and `judge` evaluate explicit values.
 */
export interface EveEvalContext<TContext = unknown> extends EveEvalAssertions {
  /** Run-wide setup context, shared by reference across evals and teardown. */
  readonly context: TContext;
  /** Eval timeout signal. */
  readonly abortSignal: AbortSignal;
  /** Current target under test. */
  readonly target: EveEvalTargetHandle;
  /** Structured eval log hook. */
  log(message: string): void;
  /** Pause the eval task, defaulting to 1 second, while respecting the eval timeout signal. */
  sleep(ms?: number): Promise<void>;
  /**
   * Create a new session without starting a turn or reading events. Resolves on
   * acceptance with a definite session id and cursor. Every call creates a session.
   */
  session(options?: CreateSessionOptions): Promise<EveEvalSession>;
  /** Create a new session with its first message and wait for the turn to settle. */
  send(message: SendTurnInput["message"], options?: SendTurnOptions): Promise<EveEvalTurn>;

  /** Apply a value-level assertion (from `eve/evals/expect`) to a value. */
  check(value: unknown, assertion: Assertion): AssertionHandle;
  /**
   * Record a score from 0 to 1. Chain `.label(key)` to name it, `.gate(0.9)`
   * to fail the eval below 0.9, or `.atLeast(0.9)` to mark it `scored`.
   * Without a rule the score has no verdict.
   */
  score(evaluation: ScoreInput): AssertionHandle;
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
  /** Attach to an exact session ID without I/O. Read it with nextTurn() or watch(). */
  attach(sessionId: string, opts?: { readonly startIndex?: number }): EveEvalSession;
}

/** Where a watched read starts, and what ends it when no turn boundary does. */
export interface EveEvalWatchOptions {
  /** The stream line to start from. */
  readonly startIndex?: number;
  /** Ends the read with the line holding the first matching event, instead of a turn boundary. */
  readonly until?: (event: SessionStreamEvent) => boolean;
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
   * Judge model for this eval's `t.judge(...)` assertions. Optional: when
   * omitted, judge assertions fall back to the `judge` declared in
   * `evals.config.ts`, then the shared decision default. Only used for
   * scoring; never changes the agent under test.
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
export interface EveEvalInput<TContext = unknown> extends EveEvalBase {
  /** Imperative interaction-and-assertion script. */
  test(t: EveEvalContext<TContext>): void | Promise<void>;
}

/**
 * Eval returned by `defineEval()`. Carries no `id` yet: discovery stamps
 * the path-derived id at import time to produce a full {@link EveEval}. The
 * `_tag` literal (`"EveEval"`) brands the value so discovery and the runner
 * can recognize a defined eval.
 */
export type EveEvalDefinition<TContext = unknown> = EveEvalInput<TContext> & {
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
  /** 1-based attempt number, present only when the run repeats evals. */
  readonly attempt?: number;
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
export interface EveEvalConfigInput<TContext = unknown> {
  /**
   * Runs once before target startup, except for `--list` or an empty selection.
   * The return value is shared with evals and teardown by reference in the runner process.
   */
  readonly setup?: () => TContext | Promise<TContext>;
  /**
   * Runs once after server and sandbox shutdown, even if setup or eval execution fails.
   * Receives undefined if setup returns no context or throws before returning.
   * Can be used without setup.
   * Does not run for `--list` or an empty selection.
   */
  teardown?(context: TContext | undefined): void | Promise<void>;
  /**
   * Default judge model for `t.judge(...)` assertions across every eval.
   * Optional: omission uses the shared decision default. Individual evals
   * may override it with their own `judge`. Only ever used for scoring.
   */
  readonly judge?: EveEvalJudgeConfig;
  /**
   * Reporters that observe every eval in the run (e.g. a shared
   * `braintrustReporter()` experiment). Suppressed by `eve eval --skip-report`.
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
  /**
   * Number of times to run every eval, to measure repeatability. Must be a
   * positive integer. `eve eval --repeat` overrides it; defaults to 1. Each
   * attempt is a separate result tagged with its 1-based `attempt`.
   */
  readonly repeat?: number;
}

/**
 * Validated eval run configuration returned by `defineEvalConfig()`. The
 * `_tag` literal brands the value so discovery can recognize it.
 */
export type EveEvalConfig<TContext = unknown> = EveEvalConfigInput<TContext> & {
  readonly _tag: "EveEvalConfig";
};

/** Setup context type associated with an authored eval config. */
export type EveEvalConfigContext<TConfig extends EveEvalConfig> = Awaited<
  ReturnType<NonNullable<TConfig["setup"]>>
>;
