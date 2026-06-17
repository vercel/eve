import type { UserContent } from "ai";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { JsonObject } from "#shared/json.js";

export type { ContextAccessor } from "#context/key.js";
export type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";

import type { ChannelInstrumentationProjection } from "#channel/instrumentation.js";

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/**
 * Identifies one turn within a session.
 *
 * `id` is the stable, unique turn identifier. `sequence` is the turn's
 * zero-based position in the session's turn order (the first turn is `0`).
 */
export interface SessionTurn {
  readonly id: string;
  readonly sequence: number;
}

/**
 * Lineage metadata for the eve parent execution that delegated this session.
 *
 * `sessionId` and `turn` describe the **immediate** parent that dispatched
 * this child. `rootSessionId` denormalizes the top of the dispatch chain so
 * descendants identify the user-facing session without walking up
 * parent-by-parent. Always populated at dispatch: a first-level child sets it
 * to the top session's id (its immediate parent), and deeper descendants
 * inherit the same root.
 */
export interface SessionParent {
  /**
   * Parent runtime-action tool call id that created this child session.
   */
  readonly callId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turn: SessionTurn;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Authenticated caller principal attached to a request.
 *
 * Route-level auth strategies (JWT, OIDC, HTTP Basic, etc.) produce this
 * and pass it to the runtime on {@link RunInput.auth} and
 * {@link DeliverInput.auth}.
 */
export interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly subject?: string;
}

/**
 * Runtime-provided function that writes one event to the event stream.
 *
 * Backed by `getWritable()` in the workflow runtime. Not part of the adapter
 * interface: the runtime always writes events itself.
 */
export type EventEmitFn = (event: HandleMessageStreamEvent) => Promise<void>;

// ---------------------------------------------------------------------------
// Deliver payload
// ---------------------------------------------------------------------------

/**
 * Base deliver payload crossing the runtime boundary.
 *
 * The runtime reads {@link message} and {@link inputResponses} for delivery
 * coalescing. Adapters extend this interface with their own typed fields (e.g.
 * Slack adapters add `interaction`) and receive the extended type through the
 * generic payload on their `deliver` hook.
 *
 * `message` is a plain text string or an AI SDK `UserContent` array (mixing
 * `text`, `image`, and `file` parts), letting channels forward file
 * attachments and other multimodal input straight to the harness.
 */
export interface DeliverPayload {
  readonly inputResponses?: readonly InputResponse[];
  readonly message?: string | UserContent;
  readonly context?: readonly string[];
  readonly outputSchema?: JsonObject;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Hook payload
// ---------------------------------------------------------------------------

/**
 * Deliver payload sent through the workflow `resumeHook`.
 *
 * Wraps the raw {@link DeliverPayload} with an optional auth update so
 * deliver-time auth crosses the durable hook boundary without a process-local
 * side-channel.
 */
export interface DeliverHookPayload {
  readonly auth?: SessionAuthContext | null;
  readonly kind: "deliver";
  readonly payloads: readonly DeliverPayload[];
}

/**
 * Runtime-action results resumed back into a parked parent workflow.
 */
export interface RuntimeActionResultHookPayload {
  readonly kind: "runtime-action-result";
  readonly results: readonly RuntimeActionResult[];
}

/**
 * Event coordinates attached to a proxied `input.requested` batch.
 *
 * Mirrors the `data` payload of the child's `input.requested` stream event so
 * the parent re-emits the same semantics without inventing new identifiers.
 */
export interface SubagentInputRequestEvent {
  readonly requests: readonly InputRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Proxy payload sent from a child subagent to its parent when the child parks
 * on a pending input batch.
 *
 * Runtime-internal. Channel adapters and authored code never observe this
 * kind: it exists only on the durable hook between the subagent adapter's
 * `input.requested` handler and the parent's runtime loop.
 */
export interface SubagentInputRequestHookPayload {
  readonly callId: string;
  readonly childContinuationToken: string;
  readonly childSessionId: string;
  readonly event: SubagentInputRequestEvent;
  readonly kind: "subagent-input-request";
  readonly subagentName: string;
}

/**
 * Serializable payload sent through the workflow `resumeHook`.
 */
export type HookPayload =
  | DeliverHookPayload
  | RuntimeActionResultHookPayload
  | SubagentInputRequestHookPayload;

/**
 * Terminal callback metadata attached to a session at creation.
 *
 * `url` is the absolute callback endpoint. `token` is the capability token
 * embedded in the framework-owned callback route. `callId` and `subagentName`
 * correlate the callee's terminal callback to the pending parent tool call.
 */
export interface SessionCallback {
  readonly callId: string;
  readonly subagentName: string;
  readonly token: string;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Runtime capabilities granted to one eve session.
 *
 * Capabilities describe what the session may do mid-turn: a session-level
 * contract, orthogonal to {@link RunInput.mode} which decides done-vs-park on
 * an empty turn.
 *
 * Channel routes that can reach a human (HTTP, Slack, etc.) set
 * `requestInput: true` when starting a run. Subagent dispatch inherits the
 * parent's capabilities pointwise, so HITL bubbles up transparently through a
 * conversation chain and stays disabled in a scheduled chain.
 */
export interface SessionCapabilities {
  /**
   * True when the session may request input from a human (tool approvals,
   * `ask_question`). The runtime reads this in every HITL gate:
   *
   * 1. `ask_question` tool registration in `buildToolSet`: the tool is hidden
   *    from the model when the session cannot request input.
   * 2. The pending-input park guard: scheduled task sessions without this flag
   *    fail fast rather than waiting for a response, covering both tool
   *    approvals and `ask_question` prompts the model has already emitted.
   */
  readonly requestInput?: boolean;
}

// ---------------------------------------------------------------------------
// Run / deliver inputs
// ---------------------------------------------------------------------------

/**
 * Single input shape consumed by {@link Runtime.run} for both root runs
 * (started by routes) and delegated child runs (started by the
 * subagent tool wrapper).
 */
export interface RunInput {
  readonly adapter: ChannelAdapter<any>;
  /**
   * Registered channel name for root sessions started from an authored
   * channel route. Framework runs omit this and use their framework
   * adapter kind (`http`, `schedule`, `subagent`) directly.
   */
  readonly channelName?: string;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  /**
   * Authenticated caller principal for this session. `null` means the
   * request was accepted with no credentials.
   */
  readonly auth: SessionAuthContext | null;
  /**
   * Session-level capabilities. When omitted, every flag is
   * interpreted as `false`. Channel routes that can reach a human
   * set `capabilities: { requestInput: true }`; scheduled task routes
   * leave this undefined.
   */
  readonly capabilities?: SessionCapabilities;
  /**
   * Optional terminal callback. When present, the runtime posts a single
   * callback when the session completes or fails.
   */
  readonly callback?: SessionCallback;
  /**
   * Session continuation token for delivery and hook creation. Channels can
   * re-key the session during the first turn via
   * `ctx.session.setContinuationToken(...)` (e.g. Slack adopts its first
   * post's `ts` as the thread root), so an initial placeholder token is
   * acceptable when full identity isn't known until the first message.
   */
  readonly continuationToken?: string;
  /**
   * The original (top-level) caller's auth, forwarded down the delegation
   * chain so the child's `session.auth.initiator` always resolves back to
   * whoever started the root session. Defaults to {@link auth} when omitted
   * (root session behavior).
   */
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly input: {
    readonly message: string | UserContent;
    readonly context?: readonly string[];
    readonly outputSchema?: JsonObject;
  };
  readonly mode: RunMode;
  readonly parent?: SessionParent;
}

export interface DeliverInput {
  /**
   * Authenticated caller principal for this follow-up message.
   * May differ from the session initiator when different users send
   * messages to the same session. The runtime updates `AuthKey` from
   * this field before calling the adapter's hooks.
   */
  readonly auth?: SessionAuthContext | null;
  readonly continuationToken: string;
  readonly payload: DeliverPayload;
}

/**
 * Terminal outcome of a runtime run.
 *
 * The durable event stream's `session.completed` / `session.failed`
 * events report terminal state on the workflow runtime.
 */
export type RunResult =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "waiting" };

/**
 * Handle returned immediately by `runtime.run()` before the step loop
 * completes.
 *
 * Carries the identifiers needed for stream endpoints.
 */
export interface RunHandle {
  readonly continuationToken: string;
  readonly events: ReadableStream<HandleMessageStreamEvent>;
  /**
   * Runtime-owned identifier for this session. Stream and inspection APIs
   * key on it: workflow-backed runs expose the workflow run id.
   */
  readonly sessionId: string;
}

/**
 * Runtime interface consumed by routes and the subagent tool wrapper.
 */
export interface Runtime {
  /**
   * Starts a new run from a flat platform-shape input.
   *
   * Loads the compiled bundle (using the node id baked in at construction
   * time), builds the seeded {@link AlsContext}, and drives the step loop to
   * completion.
   */
  run(input: RunInput): Promise<RunHandle>;

  /**
   * Delivers a follow-up message to a parked session.
   */
  deliver(input: DeliverInput): Promise<{ sessionId: string }>;

  /**
   * Returns a readable stream of lifecycle events for an existing session.
   *
   * Called by the framework's HTTP session-stream route and any user-authored
   * event-streaming route. Backed by the workflow API's per-session durable
   * stream.
   *
   * `options.startIndex` is the zero-based position of the first event to
   * yield, dropping earlier events. The framework HTTP session-stream route
   * forwards the `startIndex` query parameter so a reconnecting client resumes
   * after the events it already consumed without replaying the prior turn.
   */
  getEventStream(
    sessionId: string,
    options?: GetEventStreamOptions,
  ): Promise<ReadableStream<HandleMessageStreamEvent>>;
}

/**
 * Options accepted by {@link Runtime.getEventStream}.
 */
export interface GetEventStreamOptions {
  /**
   * Zero-based index of the first event to emit. Events before this index
   * are dropped. Defaults to `0` (replay the entire stream).
   */
  readonly startIndex?: number;
}
