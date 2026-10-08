import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { LanguageModel, ModelMessage, UserContent } from "ai";

import type { SessionAuthContext, SessionCapabilities } from "#channel/types.js";
import type { RuntimeIdentity, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { InputResponse } from "#shared/input.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionInstrumentation } from "#instrumentation/runtime.js";
import type { HistoryViewProjector, PreparedHistoryView } from "#shared/history-view.js";

/**
 * Serializable tool definition stored on the session.
 *
 * Carries schema but no execute function so the session stays serializable
 * across workflow step boundaries.
 */
export type SessionToolDefinition = Readonly<InternalToolDefinition>;

/** Authored-key → opaque-value map stored on `session.state`. */
export type SessionStateMap = Readonly<Record<string, unknown>>;

/**
 * Compaction configuration stored on the session.
 */
export interface CompactionConfig {
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
  readonly recentWindowSize: number;
  readonly threshold: number;
  readonly thresholdPercent?: number;
}

/**
 * Serializable agent configuration stored on the session.
 */
interface SessionAgentBase {
  /**
   * Optional model used only for compaction summaries.
   *
   * When omitted, the harness uses the active turn model for compaction.
   */
  readonly compactionModelReference?: RuntimeModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly system: string;
  readonly tools: readonly SessionToolDefinition[];
}

export type SessionAgent = SessionAgentBase &
  (
    | {
        readonly dynamicModel?: never;
        readonly modelReference: RuntimeModelReference;
      }
    | {
        readonly dynamicModel: true;
        readonly modelReference?: RuntimeModelReference;
      }
  );

/**
 * A {@link HarnessSession} without its conversation history. Session steps
 * that only publish events or change `state` rebuild this, so the history
 * never becomes part of their Workflow step input.
 */
export interface HarnessSessionBase {
  readonly agent: SessionAgent;
  readonly compaction: CompactionConfig;
  readonly continuationToken: string;
  readonly limits?: SessionLimits;
  readonly outputSchema?: JsonObject;
  /**
   * Stable identifier of the top user-facing session in the dispatch
   * chain. For a top-level session this field is `undefined` and
   * `sessionId` itself is the root. For any delegated subagent session,
   * `rootSessionId` carries the original root sessionId so descendant
   * dispatch sites (and observability tags) can attribute work back to
   * the user-facing session without walking the chain.
   */
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly sandboxState?: SandboxState;
  readonly state?: SessionStateMap;
}

/**
 * Serializable session state passed between harness and runtime.
 *
 * Only contains plain data -- no resolved model instances or tool execute
 * functions. The harness resolves those at step time via injected config.
 */
export interface HarnessSession extends HarnessSessionBase {
  readonly history: HarnessModelMessage[];
}

export function requireSessionModelReference(session: HarnessSession): RuntimeModelReference {
  const reference = session.agent.modelReference;
  if (reference === undefined) {
    throw new Error("Expected a concrete model selection for the active model call.");
  }
  return reference;
}

/**
 * Token limits stored on one durable session.
 */
export interface SessionLimits {
  /**
   * Maximum provider-reported input tokens this durable session may spend
   * before eve refuses to start another model call. Absent when the session
   * is uncapped. Root sessions default to 40M unless authored otherwise;
   * delegated subagent sessions receive the parent's remaining quota at
   * dispatch time.
   */
  readonly maxInputTokensPerSession?: number;
  /**
   * Maximum provider-reported output tokens this durable session may spend before
   * eve refuses to start another model call.
   */
  readonly maxOutputTokensPerSession?: number;
  /**
   * Maximum provider-reported model token cost this durable session may spend,
   * in US dollars, before eve refuses to start another model call.
   */
  readonly maxTokenCostUsdPerSession?: number;
}

/**
 * Input payload for a harness turn.
 *
 * Carries an optional message and/or structured input responses from the
 * channel emitter's `onDeliver`. The message may be a plain text string or
 * a structured AI SDK {@link UserContent} array (mixing `text`, `image`,
 * and `file` parts) to support multimodal attachments delivered by
 * channels. The harness resolves any pending input batch at the start of
 * `runStep` before the model call.
 */
export interface AttributedInputResponse {
  readonly auth: SessionAuthContext | null;
  readonly response: InputResponse;
}

export interface StepInput {
  /** Internal responder-bound input produced at the delivery boundary. */
  readonly attributedInputResponses?: readonly AttributedInputResponse[];
  readonly inputResponses?: readonly InputResponse[];
  readonly message?: string | UserContent;
  /** Internal actor attribution for `message`. */
  readonly messageAuth?: SessionAuthContext | null;
  /**
   * Context strings from the channel delivery. Each entry is appended as a
   * synthetic user-role message to `session.history` before the
   * delivery message. Populated by channels via `SendPayload.context`.
   */
  readonly context?: readonly string[];
  /**
   * Run-scoped schema that replaces the session's current output schema when
   * present. Omitted continuations keep the existing schema.
   */
  readonly outputSchema?: JsonObject;
  /**
   * Runtime-owned action results being resumed into the current turn.
   *
   * This field is internal to the execution/harness boundary and is never
   * produced by channels.
   */
  readonly runtimeActionResults?: readonly RuntimeActionResult[];
}

/**
 * Terminal result indicating the conversation is finished.
 */
export interface StepDone {
  readonly done: true;
  readonly output: unknown;
  /**
   * Marks a terminal turn that failed. For a delegated subagent this routes
   * the result to the parent as an error tool-result rather than an empty
   * success.
   */
  readonly isError?: boolean;
}

/**
 * The harness's instruction to the runtime about what to do next.
 *
 * - A `StepFn` reference means "call this step immediately" (tool loop continuation).
 * - `null` means "park and wait for the next user message."
 * - `StepDone` means "the conversation is finished."
 */
export type StepNext = StepDone | StepFn | null;

/** User-facing answer produced when a conversation turn settles. */
export interface SettledTurn {
  readonly output: unknown;
  readonly isError?: boolean;
  /**
   * Usage this turn added to the child's session subtree. The harness never
   * sets it; the durable turn step fills it with the per-turn delta before
   * the answer crosses the park boundary to the delegated caller.
   */
  readonly usage?: TokenUsage;
}

/**
 * Result returned by one harness step invocation.
 */
export interface StepResult {
  readonly steered?: true;
  readonly next: StepNext;
  readonly session: HarnessSession;
  /**
   * Present when a conversation turn settled with a user-facing answer; carried
   * across the park boundary so a delegated parent can be notified.
   */
  readonly settledTurn?: SettledTurn;
  /**
   * Present when the turn stays open: the model ended it while tasks work, or
   * it waits on a sign-in or tool approval it raised. It resumes when a task
   * settles, or when the person answers, steers, or cancels.
   */
  readonly held?: TurnHold;
}

export type TurnHold =
  | { readonly kind: "tasks"; readonly taskIds: readonly string[] }
  | { readonly kind: "request" };

/**
 * A single step of AI work. Takes the current session and optional user input,
 * returns the updated session and an instruction for the runtime.
 */
export type StepFn = (session: HarnessSession, input?: StepInput) => Promise<StepResult>;

/**
 * Map from tool name to its harness-owned definition.
 *
 * The harness uses these definitions for schema extraction, tool execution
 * (via {@link buildToolSet}), approval gates, and compaction hooks.
 */
export type HarnessToolMap = ReadonlyMap<string, HarnessToolDefinition>;

/** Looks up the definition a call runs by its entry name. */
export type HarnessToolLookup = Pick<HarnessToolMap, "get">;

/** The parts of a model tool call that name what it runs. */
export interface ToolCallLike {
  readonly input: unknown;
  readonly toolName: string;
}

/** A model tool call as the call to its entry, with the entry it runs. */
export interface ResolvedCall<T extends ToolCallLike> {
  readonly call: T;
  readonly definition: HarnessToolDefinition;
}

/** Resolves a model tool call to the entry it runs, if it reaches one. */
export type CallResolver = <T extends ToolCallLike>(toolCall: T) => ResolvedCall<T> | undefined;

/**
 * Callback that writes one event to the event stream.
 *
 * Composed by the runtime from the underlying writable and the channel's
 * event handler, then injected into the harness so it can emit lifecycle
 * events without knowing about writables or handlers.
 */
export type HarnessEmitFn = (
  event: UnstampedMessageStreamEvent,
  messages?: readonly import("ai").ModelMessage[],
) => Promise<void>;

/**
 * Unified event handler: emits the event to the stream, then
 * dispatches to hook subscribers and dynamic tool resolvers.
 *
 * Same signature as {@link HarnessEmitFn} but semantically broader —
 * every event goes through channel adapter, stream write, hooks,
 * and dynamic tool dispatch in one call.
 */
/** Where a model call stands: its turn and its step within the turn. */
export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** The session's participants, at the moments a step reaches without publishing an event. */
export interface StepParticipants {
  /** Chooses the model for the model call about to start, before its `step.started`. */
  selectModel(input: {
    readonly at: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly modelId: string;
  }): Promise<void>;
  /**
   * Restores the tools a parked step offered, before an approval policy reads them. A parked
   * step's own turn also gets its connections back.
   */
  restoreStep(input: {
    readonly at: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly modelId: string;
    readonly parked: boolean;
  }): Promise<void>;
}

export type HandleEventFn = (
  event: UnstampedMessageStreamEvent,
  messages?: readonly import("ai").ModelMessage[],
) => Promise<void>;

/**
 * Dependencies injected into the tool-loop harness at construction time.
 */
export interface ToolLoopHarnessConfig {
  readonly steeringSignal?: AbortSignal;
  /** Cancellation signal for the active turn. */
  readonly abortSignal?: AbortSignal;
  /**
   * Session-level capabilities. The harness reads
   * {@link SessionCapabilities.requestInput} to decide whether a session-limit
   * continuation prompt may park the session.
   */
  readonly capabilities?: SessionCapabilities;
  /** Clears model-message history without running a model turn. */
  readonly clearOnly?: boolean;
  /** Forces one context-compaction pass without running a model turn. */
  readonly compactOnly?: boolean;
  readonly handleEvent?: HandleEventFn;
  /** Projects raw durable history before it crosses a message-bearing boundary. */
  readonly historyProjector?: HistoryViewProjector;
  /** Execution-prepared view of the history supplied to the first harness step. */
  readonly historyView?: PreparedHistoryView;
  /**
   * Internal lifecycle hooks injected into each actual model attempt.
   * Omitted in production until an instrumentation runtime opts in.
   */
  readonly instrumentation?: SessionInstrumentation;
  /** Attribute work that must finish before cumulative model usage is persisted. */
  readonly titleAttributeWrite?: Promise<void>;
  /**
   * Sign-in callbacks the step's delivery carried. Each completes before anything else runs, and
   * a connection's sign-in resumes the turn that asked for it.
   */
  readonly signInCompletions?: readonly AuthorizationChallenge[];
  /** The session's participants, for the moments a step reaches without publishing an event. */
  readonly participants?: StepParticipants;
  readonly resolveModel: (reference: RuntimeModelReference) => Promise<LanguageModel>;
  /**
   * Runtime identity metadata attached to the `session.started` event.
   *
   * When provided, the harness includes this in the first `session.started`
   * event so remote consumers (eval runners, reporters) receive
   * authoritative server-side metadata.
   */
  readonly runtimeIdentity?: RuntimeIdentity;
  /**
   * Unified tool definitions for this harness step.
   *
   * Each entry carries schema, execution, and approval gates. The
   * harness derives AI SDK tool definitions, runs
   * {@link buildToolSet}, and checks approval gates from these
   * definitions directly.
   */
  readonly tools: HarnessToolMap;
}
