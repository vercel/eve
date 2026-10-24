import type { SessionEvent } from "#protocol/session-event.js";
import type { ConsumedDelivery } from "#harness/session-machine/transitions.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { LanguageModel } from "ai";
import type { MessageContent } from "#shared/message-content.js";

import type { SessionAuthContext, SessionCapabilities } from "#channel/types.js";
import type { RuntimeIdentity } from "#protocol/session-events/families/session.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { Answer } from "#shared/input.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { Principal } from "#protocol/session-events/envelope.js";
import type { InternalToolDefinition } from "#tools/definition.js";
import type { AgentReasoningDefinition, SessionUsageLimit } from "#shared/agent-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionInstrumentation } from "#instrumentation/runtime.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

/**
 * Serializable tool definition stored on the session.
 *
 * Carries schema but no execute function so the session stays serializable
 * across workflow step boundaries.
 */
export type SessionToolDefinition = Readonly<InternalToolDefinition>;

/** Authored-key → opaque-value map stored on `session.state`. */
export type SessionStateMap = Readonly<Record<string, unknown>>;

/** Prompt observations that survive rebuilding the agent's settings on each turn. */
export interface CompactionState {
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
  /** The previous request's non-history estimate, also used before the next request is built. */
  readonly requestEnvelopeTokens?: number;
}

/** Compaction configuration stored on the session. */
export interface CompactionConfig extends CompactionState {
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

/** The delivery a control arrived as: its id, and who sent it, as the wire names them. */
export interface ControlDelivery {
  readonly deliveryId: string;
  readonly principal?: Principal;
}

/**
 * What a channel's `deliver` hook makes of one payload: the input a turn receives. The message is
 * {@link MessageContent}: plain text, or text and file parts.
 */
export interface StepInput {
  /** Answers to the session's open interactions. */
  readonly answers?: readonly Answer[];
  readonly message?: MessageContent;
  /**
   * Context strings from the channel delivery. Each entry is appended as a
   * synthetic user-role message to `session.history` before the
   * delivery message. Populated by channels via `SendPayload.context`.
   */
  readonly context?: readonly string[];
  /**
   * Prior conversation from the channel delivery, added as user and assistant
   * turns before this turn's context and message. Populated by channels via
   * `SendPayload.history`.
   */
  readonly history?: readonly SessionHistoryMessage[];
  /**
   * Run-scoped schema that replaces the session's current output schema when
   * present. Omitted continuations keep the existing schema.
   */
  readonly outputSchema?: JsonObject;
}

/**
 * An answer as the session received it: the response it submits, the delivery it arrived in,
 * and who gave it when that isn't the turn's caller.
 */
export interface SubmittedAnswer extends Answer {
  readonly responseId: string;
  readonly deliveryId: string;
  /**
   * Who answered an approval when a delivery only answered requests: the turn keeps its caller.
   * `null` answers as no one; absent, the answer is the caller's.
   */
  readonly responder?: SessionAuthContext | null;
}

/**
 * A turn step's input inside the session: what `deliver` made, with each answer bound to the
 * response it submits, and what the runtime resumes. Never produced by channels.
 */
export interface HarnessStepInput extends Omit<StepInput, "answers"> {
  readonly answers?: readonly SubmittedAnswer[];
  /** Runtime-owned action results being resumed into the current turn. */
  readonly runtimeActionResults?: readonly RuntimeActionResult[];
  /**
   * What the agents behind some of {@link runtimeActionResults} spent, by call id. Each call's
   * settlement records it, so the session counts a child's usage once.
   */
  readonly delegatedUsage?: Readonly<Record<string, TokenUsage>>;
  /** The deliveries this input carries, each with what its person sent, which the turn consumes. */
  readonly deliveries?: readonly ConsumedDelivery[];
}

/**
 * Output from a terminal session, whose lifecycle has already been published.
 */
export interface StepDone {
  readonly output: unknown;
  /**
   * Marks a terminal session that failed. For a delegated subagent this routes
   * the result to the parent as an error tool-result rather than an empty
   * success.
   */
  readonly isError?: boolean;
}

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
  /** The model has input it hasn't read yet, such as its calls' results: the turn runs again. */
  readonly unreadInput?: true;
  readonly steered?: true;
  /** The session's terminal output; its published lifecycle determines whether it ended. */
  readonly ended?: StepDone;
  readonly session: HarnessSession;
  /**
   * Present when a conversation turn settled with a user-facing answer; carried
   * across the park boundary so a delegated parent can be notified.
   */
  readonly settledTurn?: SettledTurn;
}

/**
 * A single step of AI work. Takes the current session and optional user input,
 * returns the updated session, engine progress, and any settled output.
 */
export type StepFn = (session: HarnessSession, input?: HarnessStepInput) => Promise<StepResult>;

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
 * What one publish writes: one event, or every event of one transition, which the writer commits
 * as one line so readers never see half of it.
 */
export type SessionPublication = SessionEvent | readonly SessionEvent[];

/** The sink the harness emits to: see {@link HandleEventFn}. */
export type HarnessEmitFn = HandleEventFn;

/** Where a model call stands: its turn and its step within the turn. */
export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Publishes one event or one commit to the session: the stream write, then the channel and the
 * session's reactions. Composed by the runtime and injected into the harness, so the harness emits
 * lifecycle without knowing about writables or handlers.
 */
export type HandleEventFn = (
  publication: SessionPublication,
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
  readonly sessionUsageLimit?: SessionUsageLimit;
  /** Clears model-message history without running a model turn. */
  readonly clearOnly?: boolean;
  /** Forces one context-compaction pass without running a model turn. */
  readonly compactOnly?: boolean;
  /** The delivery a clear or compact control arrived as; its facts name it. */
  readonly controlDelivery?: ControlDelivery;
  readonly handleEvent?: HandleEventFn;
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
