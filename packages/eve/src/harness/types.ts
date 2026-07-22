import type { LanguageModel, ModelMessage, UserContent } from "ai";

import type { SessionCapabilities } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import type { HandleMessageStreamEvent, RuntimeIdentity } from "#protocol/message.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import type { InternalToolDefinition } from "#shared/tool-definition.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

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
}

/**
 * Serializable agent configuration stored on the session.
 */
export interface SessionAgent {
  /**
   * Optional model used only for compaction summaries.
   *
   * When omitted, the harness uses the active turn model for compaction.
   */
  readonly compactionModelReference?: RuntimeModelReference;
  /** `defineDynamic.fallback` for dynamic-model agents; serves whenever no scoped selection is set. */
  readonly dynamicModelDefaultReference?: RuntimeModelReference;
  readonly modelReference: RuntimeModelReference;
  readonly reasoning?: AgentReasoningDefinition;
  readonly system: string;
  readonly tools: readonly SessionToolDefinition[];
}

/**
 * Serializable session state passed between harness and runtime.
 *
 * Only contains plain data -- no resolved model instances or tool execute
 * functions. The harness resolves those at step time via injected config.
 */
export interface HarnessSession {
  readonly agent: SessionAgent;
  readonly compaction: CompactionConfig;
  readonly continuationToken: string;
  readonly history: ModelMessage[];
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
  /**
   * Number of local delegated subagent hops from the root session to this
   * session. Root sessions are depth 0.
   */
  readonly subagentDepth?: number;
  /**
   * Effective maximum subagent calls one `Workflow` invocation may dispatch
   * for this session, configured by `experimental_workflow({ maxSubagents })`.
   * When omitted, the dispatch step applies the framework default.
   */
  readonly workflowMaxSubagents?: number;
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
export interface StepInput {
  readonly inputResponses?: readonly InputResponse[];
  readonly message?: string | UserContent;
  /**
   * Context strings from the channel delivery. Each entry is appended
   * as a `role: "user"` message to `session.history` before the
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
   * Marks a terminal turn that failed (e.g. a task-mode turn that could not
   * fulfil its output schema). For a delegated subagent this routes the result
   * to the parent as an error tool-result rather than an empty success.
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

/**
 * Result returned by one harness step invocation.
 */
export interface StepResult {
  readonly next: StepNext;
  readonly session: HarnessSession;
}

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

/**
 * Callback that writes one event to the event stream.
 *
 * Composed by the runtime from the underlying writable and the channel's
 * event handler, then injected into the harness so it can emit lifecycle
 * events without knowing about writables or handlers.
 */
export type HarnessEmitFn = (
  event: HandleMessageStreamEvent,
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
export type HandleEventFn = (
  event: HandleMessageStreamEvent,
  messages?: readonly import("ai").ModelMessage[],
) => Promise<void>;

/**
 * Dependencies injected into the tool-loop harness at construction time.
 */
export interface ToolLoopHarnessConfig {
  /** Cancellation signal for the active turn. */
  readonly abortSignal?: AbortSignal;
  /**
   * Session-level capabilities. The harness reads
   * {@link SessionCapabilities.requestInput} when assembling the
   * per-step toolset to decide whether `ask_question` is available.
   */
  readonly capabilities?: SessionCapabilities;
  /**
   * Exposes the `Workflow` orchestration tool — an isolated JavaScript sandbox
   * whose only callable operations are this agent's subagents and remote
   * agents. Resolved from the `experimental_workflow(...)` definition exported
   * by `agent/tools/workflow.ts`. Only root sessions ever see the tool.
   * Defaults to `false`.
   */
  readonly workflow?: boolean;
  /**
   * Maximum subagent calls one `Workflow` invocation may dispatch, from the
   * authored Workflow tool definition. Advertised in the tool description;
   * the dispatch step enforces it. Defaults to
   * {@link import("#harness/workflow-subagent-limit.js").DEFAULT_WORKFLOW_MAX_SUBAGENTS}.
   */
  readonly workflowMaxSubagents?: number;
  readonly handleEvent?: HandleEventFn;
  /**
   * Execution mode for the current harness.
   *
   * Conversation mode parks after a final assistant reply so the runtime can
   * await the next user message. Task mode must return `{ done: true, output }`
   * for terminal assistant text inside the current invocation.
   */
  readonly mode: RunMode;
  /**
   * Called after compaction to let the execution layer re-apply
   * framework-owned state preservation (read-before-write reset, todo
   * re-injection). The harness appends the returned messages to the
   * compacted history.
   */
  readonly onCompaction?: () => readonly ModelMessage[];
  readonly dispatchDynamicModelEvent?: (input: {
    readonly ctx: AlsContext;
    readonly event: HandleMessageStreamEvent;
    readonly fallback: RuntimeModelReference;
    readonly messages: readonly ModelMessage[];
  }) => Promise<void>;
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
