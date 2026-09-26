import { authorizationKey } from "#client/session-utils.js";
import { conversationReducer } from "#client/conversation-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import { openConversationInputs, type ConversationState } from "#client/conversation-state.js";
import { TerminalMessageProjection } from "./message-projection.js";
import { TerminalSubagentProjection } from "./subagent-projection.js";
import type { ModelAccessChange } from "#shared/model-connection.js";
import { SteeringStream } from "#cli/dev/tui/steering-stream.js";
import {
  type ActionResultStreamEvent,
  type AgentInfoResult,
  type AuthorizationCompletedStreamEvent,
  type ConnectionAuthorizationOutcome,
  type AuthorizationRequiredStreamEvent,
  type InputOption,
  type InputRequest,
  type InputResponse,
  type SessionFailedStreamEvent,
  type StepCompletedStreamEvent,
  type MessageStreamEvent,
  Client,
  ClientSession,
} from "#client/index.js";
import { renderApplicationInfo } from "#cli/commands/info.js";
import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";
import type { OnboardingScreenEvent } from "./setup-commands.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { createEventDeduper, type EventDeduper } from "#protocol/event-dedupe.js";
import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import {
  createDevelopmentRuntimeArtifactRefresher,
  type DevelopmentRuntimeArtifactRefresher,
} from "#services/dev-client.js";
import { inspectApplication } from "#services/inspect-application.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  ChildStreamFollower,
  type ChildStreamFollowerOptions,
} from "#client/child-stream-follower.js";
import type { SubagentView } from "./subagent-projection.js";
export type {
  SubagentStepUpdate,
  SubagentToolUpdate,
  SubagentView,
} from "./subagent-projection.js";
import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";

import {
  type FailureStreamEvent,
  failureKey,
  formatFailureDetail,
  formatFailureHint,
  formatFailureMessage,
  isInterruptedError,
  localFailureHint,
} from "./errors.js";

import { probeAgentInfo } from "#services/dev-client/agent-info-probe.js";
import { parseLogDisplayMode } from "./log-display-mode.js";
import {
  formatPromptCommandHelp,
  parsePromptCommand,
  PROMPT_COMMANDS,
  type PromptCommand,
  type PromptCommandSpec,
  type ArgumentTypeaheadCommand,
} from "./prompt-commands.js";
import type { PromptArgumentSuggestion } from "./argument-typeahead.js";
import {
  createRemoteConnectionController,
  type RemoteConnectionController,
  type RemoteConnectionControllerOptions,
  type RemoteConnectionSnapshot,
} from "./remote-connection.js";
import type { RemoteAuthFlow } from "./remote-auth.js";
import { describeRemoteAuthCompletedMutations } from "./remote-auth-result.js";
import { prepareRemoteTuiAccess } from "./remote-startup.js";
import type { DevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  BOOT_DETECTIONS,
  CLI_MISSING_SETUP_ISSUE,
  detectSetupIssues,
  formatSetupIssuesLine,
  LOGIN_SETUP_ISSUE,
  orderedSetupIssues,
  normalizeLocalModelEndpoint,
  type BootDetection,
  type BootDetectionContext,
  type SetupIssue,
} from "./setup-issues.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
import type { TraceViewerRenderer } from "./traces/trace-viewer-session.js";
import type { RemoteDevelopmentTarget } from "./target.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "./types.js";
import { TerminalRenderer, type TerminalInput, type TerminalOutput } from "./terminal-renderer.js";
import {
  createVercelStatusTracker,
  type VercelStatusEffect,
  type VercelStatusSnapshot,
  type VercelStatusTracker,
  type VercelStatusTrackerOptions,
} from "./vercel-status.js";
import {
  createMcpConnectionStatusTracker,
  type McpConnectionProbe,
  type McpConnectionStatusTracker,
} from "./mcp-connection-status.js";
import type { detectProjectIdentity } from "#setup/project-resolution.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "#setup/vercel-project.js";
import type { DevDiagnostics } from "../diagnostics.js";
import type { CommandLifecycle } from "../../shutdown.js";

const defaultAssistantResponseStats: AssistantResponseStatsMode = "tokensPerSecond";
const idleRuntimeArtifactPollMs = 500;
const idleChatGptAuthPollMs = 5_000;
const idleSessionReconnectBaseDelayMs = 100;
const idleSessionReconnectMaxDelayMs = 2_000;
/**
 * Cooperative-cancel retry cadence: 8 × 250ms covers the turn-dispatch
 * window (locally the cancel hook is claimed well under a second after the
 * send is accepted) without hammering the cancel route.
 */
const turnCancelRetryDelayMs = 250;
const turnCancelAttempts = 8;

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export type AgentTUIStreamResult = {
  steer?: (message: string) => Promise<void>;
  events: AsyncIterable<AgentTUIStreamEvent> | ReadableStream<AgentTUIStreamEvent>;
  abort?: () => void;
  /**
   * Requests cooperative server-side cancellation of the streaming turn
   * (`/cancel`, Esc, or Ctrl+C; the keys steer when a message is queued). Unlike
   * {@link abort} — which drops the client stream and forces a fresh session —
   * the server settles the turn as `turn.cancelled` → `session.waiting`, so
   * the stream reaches its boundary normally and the session keeps its context.
   * Best-effort and idempotent; scoped to the turn the user observed when its id is known.
   */
  cancel?: () => void;
  turnState?: AgentTUITurnState;
};

export type AgentTUIStreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type AgentTUIStreamEvent =
  | { type: "turn-start"; turnId: string }
  | { type: "step-start"; modelId?: string }
  | { type: "step-finish"; usage?: AgentTUIStreamUsage }
  | { type: "assistant-delta"; id: string; delta: string }
  | { type: "assistant-complete"; id: string; text?: string | null }
  | { type: "assistant-remove"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-complete"; id: string; text?: string }
  | { type: "tool-call-preparing"; toolCallId: string; toolName: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; errorText: string }
  | { type: "tool-rejected"; toolCallId: string; reason: string }
  | { type: "error"; errorText: string; hint?: string; detail?: string }
  | { type: "turn-cancelled" }
  | { type: "finish"; usage?: AgentTUIStreamUsage };

export type AgentTUITurnState = {
  aborted?: boolean;
  boundaryEvent?: "session.completed" | "session.failed" | "session.waiting";
  pendingApprovals: AgentTUIToolApprovalRequest[];
  pendingQuestions: InputRequest[];
  sawSessionFailure: boolean;
  /** Id of the streaming turn, once `turn.started` names it. Scopes cancels. */
  turnId?: string;
  /** True while a cooperative-cancel request loop is running for this turn. */
  cancelInFlight?: boolean;
};

export type AgentTUISessionOptions = {
  title?: string;
  /**
   * Text to seed the editable prompt buffer with before the user types.
   * Set by the runner for the first prompt when `eve dev --input` is used.
   */
  initialDraft?: string;
  submittedPrompt?: string;
  continueSession?: boolean;
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  connectionAuth?: TerminalPartDisplayMode;
  assistantResponseStats?: AssistantResponseStatsMode;
  contextSize?: number;
};

export type AgentTUIToolApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  title?: string;
  input: unknown;
};

export type AgentTUIToolApprovalResponse = {
  approved: boolean;
  reason?: string;
};

export type AgentTUIInputOption = {
  id: string;
  label: string;
  description?: string;
  style?: "primary" | "danger" | "default";
};

export type AgentTUIInputQuestion = {
  requestId: string;
  prompt: string;
  display: "select" | "text";
  options?: ReadonlyArray<AgentTUIInputOption>;
  allowFreeform?: boolean;
};

export type AgentTUIInputQuestionResponse = {
  optionId?: string;
  text?: string;
};

export type AgentTUIAgentHeader = {
  name: string;
  serverUrl: string;
  info?: AgentInfoResult;
};

export type AgentTUIRenderer = {
  /**
   * Commits the startup card to the transcript before the first prompt and
   * refreshes it after local dev artifact changes. Optional — renderers
   * without a header simply skip it.
   */
  renderAgentHeader?(header: AgentTUIAgentHeader): void;
  /** Keeps preliminary connection diagnostics out of the startup presentation. */
  setStartupPhase?(phase: "starting" | "connecting" | "updating" | undefined): void;
  /**
   * Commits a single informational line to the transcript. Used for session
   * recovery and slash-command results. Optional.
   */
  renderNotice?(text: string): void;
  /**
   * Commits the session boundary (`┌── Session restarted, clear context.`)
   * when a dead session is replaced mid-conversation. Optional; renderers
   * without it get the plain notice.
   */
  renderSessionBoundary?(): void;
  /**
   * Commits one development sandbox lifecycle line to the transcript.
   * Optional so non-terminal renderers can ignore local prewarm progress.
   */
  renderSetupWarning?(text: string): void;
  /** Clears the setup attention line once its issue is resolved. */
  clearSetupWarning?(): void;
  /** Commits the startup `/deploy` invocation to the transcript. */
  renderCommandInvocation?(text: string): void;
  finishCommand?(outcome: CommandPresentation): void;
  choosePromptCommand?(commands: readonly PromptCommandSpec[]): Promise<string | undefined>;
  showInfoPanel?(text: string): Promise<void>;
  readonly setupFlow?: SetupFlowRenderer;
  /**
   * The renderer's full-screen local trace viewer, opened by `/traces`.
   * The returned promise resolves when the user closes the viewer.
   */
  readonly traceViewer?: TraceViewerRenderer;
  readPrompt?(options?: AgentTUISessionOptions): Promise<string | undefined>;
  /**
   * Consumes the next prompt produced by mid-turn input: the Esc-popped
   * steering message when one is staged, otherwise every message queued
   * during the turn coalesced into one. The runner calls this at a clean
   * turn boundary and submits the result as the next turn without reading
   * the prompt. Optional — renderers without mid-turn input never queue.
   */
  takeQueuedPrompt?(): string | undefined;
  /**
   * Reports the server session id backing the conversation — pushed by the
   * runner once a send is accepted, and overwritten when a later session's
   * turn is accepted. Deliberately sticky across `/reset` and interrupt
   * recovery: the terminal renderer echoes the LAST session this TUI talked
   * to in the parting line on exit, so an interrupted conversation (whose
   * replacement session never ran a turn) can still be found again
   * (`eve logs`, the session store). Optional.
   */
  setSessionId?(sessionId: string): void;
  readToolApproval?(
    request: AgentTUIToolApprovalRequest,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIToolApprovalResponse>;
  readInputQuestion?(
    question: AgentTUIInputQuestion,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIInputQuestionResponse | undefined>;
  renderStream(result: AgentTUIStreamResult, options?: AgentTUISessionOptions): Promise<void>;
  /**
   * Renders a server-initiated turn while `readPrompt` still owns input.
   * Unlike `renderStream`, this must not replace the active key consumer or
   * clear the user's draft.
   */
  renderIdleStream?(result: AgentTUIStreamResult, options?: AgentTUISessionOptions): Promise<void>;
  /**
   * The renderer's whole subagent surface — sections, nested steps and
   * tools, ghost sweeps, completion. One optional capability with required
   * members: a renderer either has a subagent view or it doesn't, and a
   * type-legal partial implementation (which would ghost placeholders or
   * duplicate parent tool rows) cannot exist.
   */
  readonly subagents?: SubagentView;
  /**
   * Out-of-band update for one MCP connection authorization lifecycle.
   * Called by the runner as `authorization.*` events arrive.
   * The renderer renders this as a persistent body section per
   * connection that transitions through `required` → `pending` →
   * one of the terminal `ConnectionAuthorizationOutcome` states.
   */
  upsertConnectionAuth?(update: ConnectionAuthUpdate): void;
  /**
   * Sets the number of connections currently awaiting an OAuth
   * callback. The renderer overrides its bottom status bar with a
   * "waiting for connection authorization" hint while this is > 0,
   * so the user understands the agent is parked, not hung.
   */
  setConnectionAuthPendingCount?(count: number): void;
  /**
   * The log display mode currently in effect. Paired with
   * {@link setLogDisplayMode}; both are absent on renderers that do not
   * capture process output.
   */
  logDisplayMode?(): LogDisplayMode;
  /**
   * Switches which captured log sources (stdout/stderr) the transcript
   * shows. Captured output is buffered regardless of mode, so a change
   * applies retroactively: hiding removes already-rendered log lines from
   * the transcript and showing restores buffered ones at their original
   * positions. Used by the `/loglevel` command.
   */
  setLogDisplayMode?(mode: LogDisplayMode): void;
  /**
   * Commits any delayed local dev build errors immediately before dispatching
   * a user prompt. Renderers without process-log capture ignore it.
   */
  flushDelayedDevBuildErrors?(): void;
  /**
   * Sets the workspace-scoped Vercel segment of the persistent bottom
   * status line. Pushed by the runner at startup and after Vercel-related
   * setup outcomes. Renderers without a status line ignore it.
   */
  setVercelStatus?(status: VercelStatusSnapshot): void;
  /** Sets the remote deployment badge and its current connection/authentication state. */
  setRemoteConnectionStatus?(status: RemoteConnectionSnapshot): void;
  /**
   * Clears the rendered transcript and resets per-conversation display
   * state, leaving the UI interactive on a fresh screen. Used by the
   * `/reset` command to start a new session with a clean slate.
   */
  reset?(): void;
  /**
   * Tears down interactive mode and restores the terminal when the runner's
   * lifecycle ends.
   */
  shutdown?(): void;
  /** Suspends an idle prompt so a server-initiated HITL request can own input. */
  suspendPromptForInput?(): void;
  requestInterrupt?(): void;
  exitRequested?(): boolean;
};

export interface PromptCommandHandlerContext {
  readonly renderer: AgentTUIRenderer;
  readonly title: string;
  /** Provider entry authorized by confirmed boot-time model-access evidence. */
  readonly initialModelStep?: "provider";
  readonly onOnboardingScreen?: (input: OnboardingScreenEvent) => void;
  /** Live ChatGPT identity shown only inside model configuration UI. */
  readonly chatGptAccountLabel?: string;
  /** Settles runtime changes before the setup panel releases the screen. */
  readonly settleOutcome?: (outcome: PromptCommandOutcome) => Promise<PromptCommandOutcome>;
  readonly withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly disabledConnectionReasons?: Readonly<Record<string, string>>;
}

/** One atomic transcript decision for an invocation, including no-output commands. */
export type CommandPresentation =
  | { kind: "dismiss" }
  | { kind: "result"; message?: string; summary?: string };

/** What one handled slash command leaves behind for the runner to apply. */
export interface PromptCommandOutcome {
  /** Outcome line rendered under the echoed command; absent renders nothing. */
  message?: string;
  /** The command failed; completed and cancelled commands share the normal settled presentation. */
  failed?: true;
  /** Replaces the echoed invocation once the command settles. */
  summary?: string;
  /** Post-command work after setup settles. */
  effect?: VercelStatusEffect | ModelAccessChange;
  cancelled?: true;
}

export interface PromptCommandHandler {
  handle(
    command: Extract<PromptCommand, { type: "extension" }>,
    context: PromptCommandHandlerContext,
  ): Promise<PromptCommandOutcome | undefined>;
}

type TuiStartup = {
  finish(): { draft: string; queuedPrompt: string | undefined };
};

export type EveTUIRunnerOptions = TuiDisplayOptions & {
  session?: ClientSession;
  /** Production TUI probe injected by the launcher; omitted in hermetic runners. */
  probeMcpConnection?: McpConnectionProbe;
  /**
   * Optional client used to attach to child sessions for live subagent
   * stream observation. When omitted, the TUI still shows the subagent
   * section but cannot surface the subagent's reasoning / response /
   * intermediate events — only the parent-stream `called` and
   * `completed` transitions.
   */
  client?: Client;
  renderer?: AgentTUIRenderer;
  screen?: TerminalOutput;
  userInput?: TerminalInput;
  /**
   * Formats an error thrown while dispatching a turn (the initial
   * `session.send()` POST — e.g. a transport failure or a Vercel
   * Deployment Protection challenge) into the text rendered in the
   * inline error region. Defaults to the error's message. Callers that
   * know about transport-specific challenges (the `eve dev` glue) inject
   * a richer formatter here.
   */
  formatTransportError?: (error: unknown) => string;
  /**
   * Local `eve dev` server URL. When present, normal prompts refresh the
   * runtime artifacts after HMR so the next prompt uses the latest authored
   * artifacts while retaining its logical session.
   */
  serverUrl?: string;
  /** Absolute local application root; omitted for remote `--url` sessions. */
  appRoot?: string;
  /** Seeds the editable prompt buffer for the first prompt. */
  initialInput?: string;
  /** Explicit fresh-agent onboarding handoff from `eve init`. */
  onboard?: boolean;
  /** Reports timestamped steps and terminal result for fresh-agent onboarding. */
  onOnboardingStep?: (input: EveCliSetupStepEvent) => void;
  onOnboardingTerminal?: (input: EveCliSetupTerminalEvent) => void;
  /** Handles non-core slash commands without adding feature branches to the runner. */
  promptCommandHandler?: PromptCommandHandler;
  /** Commands shown in discovery for this local or remote session. */
  availablePromptCommands?: readonly PromptCommandSpec[];
  /** Catalog entries available to inline `/model`, `/add`, and `/login` completion. */
  argumentSuggestions?: (
    command: ArgumentTypeaheadCommand,
  ) => Promise<readonly PromptArgumentSuggestion[]>;
  /** Gives setup subprocesses exclusive terminal and development-host ownership. */
  withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Remote target and mutable OIDC token source, when connected through `--url`. */
  remote?: {
    readonly target: RemoteDevelopmentTarget;
    readonly credentials: DevelopmentCredentialGate;
    readonly resolveOidcToken: NonNullable<RemoteConnectionControllerOptions["resolveOidcToken"]>;
    readonly resolveDeployment: NonNullable<RemoteConnectionControllerOptions["resolveDeployment"]>;
    /** Test seam for consented deployment access repair. */
    readonly runAuthFlow?: RemoteAuthFlow;
  };
  /** Boot-time installation-state checks; defaults to the built-ins. */
  bootDetections?: readonly BootDetection[];
  /** Test seam for the status line's Vercel link probe; defaults to the real one. */
  detectProjectIdentity?: typeof detectProjectIdentity;
  /** Test seam for `/info`; defaults to the filesystem application inspector. */
  inspectApplication?: typeof inspectApplication;
  /** Test seam for the off-critical-path boot login probe; defaults to the real one. */
  getVercelAuthStatus?: typeof getVercelAuthStatus;
  /** Reports phases from this runner's initial local-dev connection. */
  onBootProgress?: DevBootProgressReporter;
  /** Parent-owned diagnostics recorder; omitted for remote and test renderers. */
  diagnostics?: DevDiagnostics;
  lifecycle?: CommandLifecycle;
  /** Editing-only startup state retained until the final agent header is ready to paint. */
  startup?: TuiStartup;
};

/** The attention-line issue for a Vercel auth state, or undefined when nothing's wrong. */
function authIssueForStatus(status: VercelAuthStatus): SetupIssue | undefined {
  if (status === "logged-out") return LOGIN_SETUP_ISSUE;
  if (status === "cli-missing") return CLI_MISSING_SETUP_ISSUE;
  return undefined;
}

export class EveTUIRunner {
  #session: ClientSession | undefined;
  readonly #client?: Client;
  readonly #renderer: AgentTUIRenderer;
  readonly #name: string;
  readonly #tools: TerminalPartDisplayMode;
  readonly #reasoning: TerminalPartDisplayMode;
  readonly #subagents: TerminalPartDisplayMode;
  readonly #connectionAuth: TerminalPartDisplayMode;
  readonly #assistantResponseStats: AssistantResponseStatsMode;
  readonly #contextSize?: number;
  readonly #formatTransportError: (error: unknown) => string;
  readonly #runtimeArtifacts?: DevelopmentRuntimeArtifactRefresher;
  readonly #serverUrl?: string;
  readonly #appRoot?: string;
  /** Seeds the first prompt's editable buffer. */
  readonly #initialInput?: string;
  readonly #startup?: TuiStartup;
  #startupPrompt?: string;
  /** Explicit fresh-agent onboarding handoff from `eve init`. */
  readonly #onboard: boolean;
  #reportedFirstResponse = false;
  readonly #onOnboardingStep?: EveTUIRunnerOptions["onOnboardingStep"];
  readonly #onOnboardingTerminal?: EveTUIRunnerOptions["onOnboardingTerminal"];
  #startupActive = true;
  readonly #promptCommandHandler?: PromptCommandHandler;
  readonly #availablePromptCommands: readonly PromptCommandSpec[];
  readonly #withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #remoteConnection?: RemoteConnectionController;
  readonly #remoteAuthFlow?: RemoteAuthFlow;
  readonly #bootDetections: readonly BootDetection[];
  readonly #getVercelAuthStatus: typeof getVercelAuthStatus;
  readonly #inspectApplication: typeof inspectApplication;
  #onBootProgress?: DevBootProgressReporter;
  /** Set when the run loop unwinds, so a late boot login probe cannot paint into a torn-down terminal. */
  #disposed = false;
  /** Aborts the off-critical-path boot auth probe when the run loop unwinds. */
  readonly #authProbeAbort = new AbortController();
  /**
   * Set once a setup command changes Vercel state (any status-line effect), so
   * a slow boot login probe that resolves afterward cannot paint a stale
   * "not logged in" hint over a session the user has since logged into.
   */
  #authHintStale = false;
  #setupAttentionRevision = 0;
  #agentInfoRevision = 0;
  /** Cheap-and-local boot detection issues, cached so the auth probe can re-combine. */
  #bootIssues: SetupIssue[] = [];
  /** The current Vercel auth issue (login / CLI-missing), or undefined when fine. */
  #authIssue: SetupIssue | undefined;
  /**
   * Vercel segment of the status line (link identity + session-scoped
   * pending-deploy flag). Only local sessions carry one — a remote `--url`
   * session has no workspace to be linked.
   */
  readonly #vercelStatus?: VercelStatusTracker;
  readonly #mcpConnectionStatus?: McpConnectionStatusTracker;
  #agentInfo?: AgentInfoResult;
  #conversation: ConversationState = conversationReducer.initial();
  #seenEvents = createEventDeduper();
  /** Idle wake result handed from the prompt follower into the normal HITL response loop. */
  #idleInputResult?: AgentTUIStreamResult;
  /** Registry setups queued by tool results on root or child streams. */
  readonly #pendingRegistrySetups: string[] = [];
  #activeRegistrySetup?: string;
  /** True only while the idle prompt owns terminal input. */
  #readingPrompt = false;
  readonly #childStreamFollower: ChildStreamFollower;
  readonly #subagentProjection?: TerminalSubagentProjection;
  /**
   * Attempt identity → latest known state for one MCP connection
   * authorization lifecycle (name for legacy events). Persists across turns:
   * a turn suspended on a webhook callback resumes later — the
   * `_required`/`_pending` events fire in turn N and the `_completed`
   * event may not arrive until turn N+1. Each entry holds enough
   * context to re-render the body section idempotently from any
   * single event.
   */
  readonly #connectionAuthRuns = new Map<string, ConnectionAuthRun>();
  /**
   * Set of authorization attempt keys currently in the `pending` state — i.e.
   * the workflow is suspended waiting on the framework-owned OAuth
   * callback. Used to drive the renderer's bottom-bar hint.
   */
  readonly #pendingConnectionAuths = new Set<string>();
  /**
   * The exact session that reported a terminal failure. Recovery replaces it
   * only if it is still current, so a stale failure from A cannot replace B.
   */
  #failedSession?: ClientSession;
  readonly #lifecycle?: CommandLifecycle;

  constructor(options: EveTUIRunnerOptions) {
    this.#session = options.session;
    if (options.client !== undefined) this.#client = options.client;
    if (options.lifecycle !== undefined) this.#lifecycle = options.lifecycle;
    this.#renderer = createRenderer(options);
    const projectChild = (event: EveAgentReducerEvent, callId: string) => {
      this.#conversation = conversationReducer.reduce(this.#conversation, event);
      this.#subagentProjection?.update(this.#conversation, callId);
    };
    const followerOptions: ChildStreamFollowerOptions = {
      session: (parentSessionId) => this.#client?.sessions.attach(parentSessionId) ?? this.#session,
      getCall: (callId) => this.#conversation.children[callId],
      onFollowing: (callId) =>
        projectChild({ type: "client.child.following", data: { callId } }, callId),
      onUnavailable: (data) =>
        projectChild({ type: "client.child.unavailable", data }, data.callId),
      onChildEvent: (callId, event) =>
        projectChild({ type: "client.child.observed", data: { callId, event } }, callId),
    };
    if (this.#renderer.subagents !== undefined) {
      this.#subagentProjection = new TerminalSubagentProjection(this.#renderer.subagents);
    }
    if (options.appRoot !== undefined) {
      followerOptions.onToolCompleted = async (subagentName, toolName, output) => {
        const address = registryHandoffAddress(subagentName, toolName, output);
        if (address !== undefined) this.#queueRegistrySetup(address);
      };
    }
    this.#childStreamFollower = new ChildStreamFollower(followerOptions);
    this.#name = options.name ?? "eve";
    this.#withExclusiveTerminal = options.withExclusiveTerminal;
    this.#tools = options.tools ?? "full";
    this.#reasoning = options.reasoning ?? "full";
    this.#subagents = options.subagents ?? "full";
    this.#connectionAuth = options.connectionAuth ?? "full";
    this.#assistantResponseStats = options.assistantResponseStats ?? defaultAssistantResponseStats;
    this.#contextSize = options.contextSize;
    this.#formatTransportError = options.formatTransportError ?? toErrorMessage;
    if (options.initialInput !== undefined) this.#initialInput = options.initialInput;
    if (options.startup !== undefined) this.#startup = options.startup;
    this.#onboard = options.onboard === true;
    this.#onOnboardingStep = options.onOnboardingStep;
    this.#onOnboardingTerminal = options.onOnboardingTerminal;
    if (options.appRoot !== undefined) {
      this.#appRoot = options.appRoot;
      const trackerOptions: VercelStatusTrackerOptions = {
        appRoot: options.appRoot,
        onChange: (snapshot) => this.#renderer.setVercelStatus?.(snapshot),
      };
      if (options.detectProjectIdentity !== undefined) {
        trackerOptions.detectIdentity = options.detectProjectIdentity;
      }
      this.#vercelStatus = createVercelStatusTracker(trackerOptions);
      if (options.probeMcpConnection !== undefined) {
        this.#mcpConnectionStatus = createMcpConnectionStatusTracker({
          onChange: () => {},
          probe: options.probeMcpConnection,
        });
      }
    }
    if (options.promptCommandHandler !== undefined) {
      this.#promptCommandHandler = options.promptCommandHandler;
    }
    this.#availablePromptCommands = options.availablePromptCommands ?? PROMPT_COMMANDS;
    if (options.remote !== undefined) {
      this.#remoteAuthFlow = options.remote.runAuthFlow;
      if (this.#client === undefined) {
        throw new Error("A remote TUI requires a configured development client.");
      }
      this.#remoteConnection = createRemoteConnectionController({
        client: this.#client,
        credentials: options.remote.credentials,
        target: options.remote.target,
        onChange: (snapshot) => this.#renderer.setRemoteConnectionStatus?.(snapshot),
        resolveOidcToken: options.remote.resolveOidcToken,
        resolveDeployment: options.remote.resolveDeployment,
      });
    }
    this.#bootDetections = options.bootDetections ?? BOOT_DETECTIONS;
    this.#getVercelAuthStatus = options.getVercelAuthStatus ?? getVercelAuthStatus;
    this.#inspectApplication = options.inspectApplication ?? inspectApplication;
    if (options.onBootProgress !== undefined) this.#onBootProgress = options.onBootProgress;
    if (options.serverUrl !== undefined) this.#serverUrl = options.serverUrl;
    if (options.serverUrl !== undefined && options.remote === undefined) {
      this.#runtimeArtifacts = createDevelopmentRuntimeArtifactRefresher({
        serverUrl: options.serverUrl,
      });
    }
  }

  /**
   * Fetches the agent inspection payload (best-effort) and renders the startup
   * header. Never throws: a missing or unauthorized `/eve/v1/info` simply
   * yields a header without the agent's configuration detail.
   */
  async #loadInitialAgentInfo(): Promise<void> {
    const serverUrl = this.#serverUrl;
    if (serverUrl === undefined) {
      this.#reportBeforeFirstPaint();
      if (!this.#onboard) await this.#renderSetupIssues(undefined);
      return;
    }

    let info: AgentInfoResult | undefined;
    if (this.#remoteConnection !== undefined) {
      const connection = await this.#remoteConnection.check();
      if (connection.state === "ready") info = connection.info;
    } else {
      const client = this.#client;
      if (client !== undefined) {
        try {
          const probe = await devBootPhase(
            "connecting to agent",
            () => probeAgentInfo({ client, timeoutMs: 2000 }),
            this.#onBootProgress,
          );
          if (probe.kind === "ready") info = probe.info;
        } catch {
          info = undefined;
        }
      }
    }
    this.#reportBeforeFirstPaint();
    const headerInfo = this.#replaceAgentInfo(info);
    if (!this.#onboard) await this.#renderSetupIssues(headerInfo);
  }

  #finishStartup(): string | undefined {
    const startup = this.#startup?.finish();
    this.#startupPrompt = startup?.queuedPrompt;
    return startup?.draft ?? this.#initialInput;
  }

  #replaceAgentInfo(info: AgentInfoResult | undefined): AgentInfoResult | undefined {
    const headerInfo =
      this.#appRoot === undefined ? info : normalizeLocalModelEndpoint(info, process.env);
    this.#agentInfo = headerInfo;
    const serverUrl = this.#serverUrl;
    if (serverUrl === undefined || this.#startupActive) return headerInfo;

    const header: AgentTUIAgentHeader = {
      name: this.#name,
      serverUrl,
    };
    if (headerInfo !== undefined) header.info = headerInfo;
    this.#renderer.renderAgentHeader?.(header);
    return headerInfo;
  }

  #reportBeforeFirstPaint(): void {
    const report = this.#onBootProgress;
    this.#onBootProgress = undefined;
    report?.({ type: "before-first-paint" });
  }

  async run() {
    const onStop = () => this.#renderer.requestInterrupt?.();
    if (this.#lifecycle?.signal.aborted === true) onStop();
    else this.#lifecycle?.signal.addEventListener("abort", onStop, { once: true });
    try {
      await this.#run();
    } finally {
      this.#lifecycle?.signal.removeEventListener("abort", onStop);
      this.#disposed = true;
      this.#authProbeAbort.abort();
      this.#childStreamFollower.abortAll();
      // Restore captured stdout/stderr before a fatal error reaches the CLI.
      this.#renderer.shutdown?.();
      // Drops any in-flight link probe so a late resolution cannot paint
      // into a torn-down terminal.
      this.#vercelStatus?.dispose();
      this.#mcpConnectionStatus?.dispose();
      this.#remoteConnection?.dispose();
    }
  }

  async #run() {
    const title = this.#name;
    let prompt: string | undefined;
    let pendingInputResponses: readonly InputResponse[] | undefined;
    let hasRunTurn = false;
    let followCurrentSession = false;
    let streamWithoutPrompt = false;
    this.#renderer.setStartupPhase?.("starting");
    await this.#loadInitialAgentInfo();
    // Fire-and-forget: the link identity is network-bound to resolve, and the
    // first prompt must not wait on it. The segment appears when it lands.
    this.#vercelStatus?.refreshIdentity();
    this.#mcpConnectionStatus?.refresh();

    const initialAgentOnboarding =
      (this.#onboard ||
        (this.#agentInfo?.agent.model.endpoint?.kind === "gateway" &&
          !this.#agentInfo.agent.model.endpoint.connected)) &&
      this.#appRoot !== undefined &&
      this.#promptCommandHandler !== undefined &&
      this.#renderer.setupFlow !== undefined;
    let startupOutcome: PromptCommandOutcome | undefined;
    if (this.#remoteConnection !== undefined && this.#renderer.setupFlow !== undefined) {
      const access = await prepareRemoteTuiAccess({
        connection: this.#remoteConnection,
        renderer: this.#renderer.setupFlow,
        signal: this.#lifecycle?.signal,
        runAuthFlow: this.#remoteAuthFlow,
      });
      if (access?.kind === "authenticated") {
        const connection = this.#remoteConnection.current().connection;
        if (connection.state === "ready") this.#replaceAgentInfo(connection.info);
      } else if (access?.kind === "failed" || access?.kind === "unavailable") {
        startupOutcome = {
          failed: true,
          message: access.kind === "failed" ? access.message : access.failure.message,
        };
      } else if (access?.kind === "cancelled") {
        startupOutcome = { cancelled: true };
        if (access.completedMutations.length > 0) {
          startupOutcome.message = `Completed before cancellation: ${describeRemoteAuthCompletedMutations(access.completedMutations).join(", ")}.`;
        }
      }
    }
    if (initialAgentOnboarding) {
      this.#renderer.setStartupPhase?.("connecting");
      startupOutcome = await this.#runInitialAgentOnboarding(title);
    }

    let initialDraft = this.#finishStartup();
    if (startupOutcome?.cancelled || startupOutcome?.failed) {
      initialDraft = [this.#startupPrompt, initialDraft].filter(Boolean).join("\n\n") || undefined;
    } else {
      prompt = this.#startupPrompt;
    }
    this.#startupActive = false;
    this.#replaceAgentInfo(this.#agentInfo);
    this.#paintSetupAttention();
    this.#renderer.setStartupPhase?.(undefined);
    if (!initialAgentOnboarding || startupOutcome?.cancelled || startupOutcome?.failed) {
      if (startupOutcome?.message !== undefined)
        this.#finishCommand({ kind: "result", message: startupOutcome.message });
    }

    while (true) {
      if (this.#lifecycle?.signal.aborted === true || this.#renderer.exitRequested?.() === true) {
        return;
      }
      const pendingRegistrySetup = this.#pendingRegistrySetups[0];
      if (
        pendingRegistrySetup !== undefined &&
        pendingInputResponses === undefined &&
        this.#idleInputResult === undefined
      ) {
        this.#pendingRegistrySetups.shift();
        this.#activeRegistrySetup = pendingRegistrySetup;
        try {
          await this.#openRegistrySetup(pendingRegistrySetup);
        } finally {
          this.#activeRegistrySetup = undefined;
        }
        followCurrentSession = false;
        streamWithoutPrompt = false;
        prompt = undefined;
        continue;
      }
      if (!streamWithoutPrompt) {
        if (prompt == null) {
          if (!this.#renderer.readPrompt) {
            if (hasRunTurn) {
              return;
            }

            throw new Error(
              "No prompt was provided and the renderer does not support prompt input.",
            );
          }

          const promptOptions: AgentTUISessionOptions = { title };
          if (initialDraft !== undefined) {
            promptOptions.initialDraft = initialDraft;
            initialDraft = undefined;
          }

          try {
            this.#readingPrompt = true;
            prompt = await this.#readPromptFollowingSession(promptOptions);
          } catch (error) {
            if (isInterruptedError(error)) {
              if (this.#idleInputResult === undefined && this.#pendingRegistrySetups.length === 0) {
                return;
              }
              streamWithoutPrompt = true;
              prompt = "";
            } else {
              throw error;
            }
          } finally {
            this.#readingPrompt = false;
          }

          if (this.#pendingRegistrySetups.length > 0 && this.#idleInputResult === undefined) {
            prompt = undefined;
            continue;
          }
          if (prompt == null && this.#idleInputResult === undefined) {
            return;
          }
        }

        const command = this.#idleInputResult === undefined ? parsePromptCommand(prompt!) : null;

        if (command?.type === "exit") {
          this.#finishCommand({ kind: "dismiss" });
          this.#lifecycle?.requestStop();
          return;
        }

        if (command?.type === "cancel") {
          followCurrentSession = await this.#runSessionCommand({
            absent: "No active turn to cancel",
            accepted: "Cancellation requested",
            failed: "Couldn't cancel the turn",
            invoke: (session) => session.cancel(),
          });
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          if (!followCurrentSession) continue;
        }

        if (command?.type === "reset") {
          if (!(await this.#resetCurrentSession())) {
            pendingInputResponses = undefined;
            streamWithoutPrompt = false;
            prompt = undefined;
            continue;
          }
          this.#finishCommand({ kind: "dismiss" });
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        if (command?.type === "compact") {
          followCurrentSession = await this.#runSessionCommand({
            absent: "No active session to compact",
            accepted: "Compaction requested",
            failed: "Couldn't compact the session",
            invoke: (session) => session.compact(),
          });
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          if (!followCurrentSession) continue;
        }

        if (command?.type === "clear") {
          followCurrentSession = await this.#runSessionCommand({
            absent: "No active session to clear",
            failed: "Couldn't clear the session",
            dismissOnAccepted: true,
            invoke: (session) => session.clear(),
          });
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          if (!followCurrentSession) continue;
        }

        // Help renders locally; unlike extension commands it must work even
        // without a prompt-command handler (e.g. remote --url sessions).
        if (command?.type === "help") {
          if (this.#renderer.choosePromptCommand !== undefined) {
            const selected = await this.#renderer.choosePromptCommand!(
              this.#availablePromptCommands,
            );
            if (selected !== undefined) initialDraft = selected;
          } else
            this.#finishCommand({
              kind: "result",
              message: formatPromptCommandHelp(this.#availablePromptCommands),
            });
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        if (command?.type === "info") {
          await this.#showApplicationInfo();
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        // Like /help, /loglevel renders locally: it adjusts the renderer's
        // own log filter, so it works without a prompt-command handler.
        if (command?.type === "loglevel") {
          const outcome = this.#applyLogLevelCommand(command.argument);
          const error =
            outcome.startsWith("/loglevel is not available") ||
            outcome.startsWith("Unknown log level");
          this.#finishCommand(
            error ? { kind: "result", message: outcome } : { kind: "result", summary: outcome },
          );
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        // /traces is renderer-local too: the viewer reads the local spool
        // from disk and owns the screen until the user closes it.
        if (command?.type === "traces") {
          await this.#openTraceViewer(command.argument);
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        if (command?.type === "extension") {
          try {
            await this.#executeExtensionCommand(command, title, { trigger: "command" });
          } catch (error) {
            if (isInterruptedError(error)) return;
            throw error;
          }
          pendingInputResponses = undefined;
          prompt = undefined;
          streamWithoutPrompt = false;
          continue;
        }

        hasRunTurn = true;
      }

      const idleInputResult = this.#idleInputResult;
      this.#idleInputResult = undefined;
      let result =
        idleInputResult ??
        (followCurrentSession
          ? this.#streamCurrentSession()
          : await (async () => {
              this.#recoverFailedSession();
              return await this.#streamTurn({
                prompt: streamWithoutPrompt ? undefined : prompt,
                inputResponses: pendingInputResponses,
              });
            })());
      // The session id becomes known once the send is accepted; keep the
      // renderer's copy fresh so the parting line can name the session.
      const acceptedSessionId = this.#session?.state.sessionId;
      if (acceptedSessionId !== undefined) {
        this.#renderer.setSessionId?.(acceptedSessionId);
      }
      let submittedPrompt = prompt;
      let respondedToInputRequest = false;

      try {
        while (true) {
          await this.#renderer.renderStream(result, {
            title,
            submittedPrompt,
            continueSession: Boolean(this.#renderer.readPrompt),
            tools: this.#tools,
            reasoning: this.#reasoning,
            subagents: this.#subagents,
            connectionAuth: this.#connectionAuth,
            assistantResponseStats: this.#assistantResponseStats,
            contextSize: this.#contextSize,
          });

          const approvalRequests = result.turnState?.pendingApprovals ?? [];
          const questionRequests = result.turnState?.pendingQuestions ?? [];

          if (approvalRequests.length > 0 || questionRequests.length > 0) {
            const responses: InputResponse[] = [];

            if (approvalRequests.length > 0) {
              if (!this.#renderer.readToolApproval) {
                throw new Error(
                  "Tool approval was requested, but the renderer does not support tool approval input.",
                );
              }

              for (const request of approvalRequests) {
                const response = await this.#renderer.readToolApproval(request, { title });
                responses.push({
                  requestId: request.approvalId,
                  optionId: response.approved ? "approve" : "cancel",
                });
              }
            }

            if (questionRequests.length > 0) {
              if (!this.#renderer.readInputQuestion) {
                throw new Error(
                  "An interactive question was requested, but the renderer does not support input questions.",
                );
              }

              for (const inputRequest of questionRequests) {
                const question = toAgentTUIInputQuestion(inputRequest);
                const response = await this.#renderer.readInputQuestion(question, { title });
                if (response === undefined) {
                  continue;
                }
                const inputResponse: InputResponse = { requestId: inputRequest.requestId };
                if (response.optionId !== undefined) inputResponse.optionId = response.optionId;
                if (response.text !== undefined) inputResponse.text = response.text;
                responses.push(inputResponse);
              }
            }

            if (responses.length === 0) {
              // Every pending question was skipped without an answer. Fall
              // back to the prompt rather than sending an empty response set:
              // the questions stay open, and the server decides whether the
              // user's next message answers, dismisses, or leaves them.
              break;
            }

            this.#conversation = conversationReducer.reduce(this.#conversation, {
              type: "client.input.responded",
              data: { createdAt: Date.now(), responses },
            });
            streamWithoutPrompt = true;
            pendingInputResponses = responses;
            prompt = undefined;
            respondedToInputRequest = true;
            break;
          }

          if (this.#enterPendingConnectionAuthorization(result)) {
            result = this.#streamCurrentSession();
            submittedPrompt = undefined;
            continue;
          }

          if (result.turnState && result.turnState.boundaryEvent === undefined) {
            if (!result.turnState.aborted) {
              const strandedSessionId = this.#session?.state.sessionId;
              this.#renderer.renderNotice?.(
                strandedSessionId
                  ? `Lost the event stream — the turn may still be running on the server (session ${strandedSessionId}). Your next message resumes this session; use /cancel to stop the turn.`
                  : "Lost the connection to the running turn.",
              );
            }
          }
          break;
        }
      } catch (error) {
        if (isInterruptedError(error)) {
          return;
        }

        throw error;
      }

      if (respondedToInputRequest) {
        continue;
      }

      followCurrentSession = false;
      streamWithoutPrompt = false;
      pendingInputResponses = undefined;
      prompt = undefined;

      // A staged key-driven steer message, or messages queued during the turn,
      // submit immediately as the next turn — but only across a clean turn
      // boundary. A failed session or a lost stream keeps them; the renderer
      // restores them into the next prompt's editable buffer instead of
      // firing them into a session whose state the user hasn't seen.
      const boundaryEvent = result.turnState?.boundaryEvent;
      const currentSessionFailed = this.#failedSession === this.#session;
      if (
        !currentSessionFailed &&
        (boundaryEvent === "session.waiting" || boundaryEvent === "session.completed")
      ) {
        prompt = this.#renderer.takeQueuedPrompt?.();
      }

      // The session ended terminally this turn (session.failed, a dispatch
      // failure, or a user interrupt). Replace it with a fresh one so the
      // next prompt isn't sent into a dead session, but keep the transcript
      // on screen. Server-side context is gone with the old session.
      this.#recoverFailedSession(result.turnState?.aborted === true);
    }
  }

  /**
   * Resets all per-conversation runner state and, when a client is
   * available, replaces the active session with a fresh one so the next
   * turn starts a new server-side conversation. Backs the `/reset` command.
   * In-flight subagent child-session streams are aborted.
   */
  #startNewSession(): void {
    this.#childStreamFollower.abortAll();
    this.#subagentProjection?.reset();
    this.#conversation = conversationReducer.initial();
    this.#seenEvents = createEventDeduper();
    this.#connectionAuthRuns.clear();
    this.#pendingConnectionAuths.clear();
    this.#renderer.setConnectionAuthPendingCount?.(0);

    this.#session = undefined;
    this.#runtimeArtifacts?.clear();
  }

  /** Clears one failure marker and replaces its source only by identity. */
  #recoverFailedSession(aborted = false): void {
    const failedSession = this.#failedSession;
    if (failedSession === undefined) return;
    this.#failedSession = undefined;
    if (this.#session !== failedSession) return;

    this.#startNewSession();
    if (aborted) {
      this.#renderer.renderNotice?.(
        "Stopped following the turn and started a new session. Earlier context was cleared; the interrupted turn may still be running on the server.",
      );
    } else if (this.#renderer.renderSessionBoundary !== undefined) {
      this.#renderer.renderSessionBoundary();
    } else {
      this.#renderer.renderNotice?.(
        "Session ended — started a new session. Earlier context was cleared.",
      );
    }
  }

  /** Runs a session mutation and gives every control command one completion policy. */
  async #runSessionCommand(input: {
    readonly absent: string;
    readonly accepted?: string;
    readonly failed: string;
    readonly dismissOnAccepted?: boolean;
    readonly invoke: (session: ClientSession) => Promise<{ status: string }>;
  }): Promise<boolean> {
    const session = this.#session;
    if (session === undefined) {
      this.#finishCommand({ kind: "result", summary: input.absent });
      return false;
    }
    try {
      const result = await input.invoke(session);
      if (result.status !== "accepted") {
        this.#finishCommand({ kind: "result", summary: input.absent });
        return false;
      }
      this.#finishCommand(
        input.dismissOnAccepted === true
          ? { kind: "dismiss" }
          : { kind: "result", summary: input.accepted },
      );
      return true;
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: toErrorMessage(error),
        summary: input.failed,
      });
      return false;
    }
  }

  /** Resets the durable owner before clearing the local conversation view. */
  async #resetCurrentSession(): Promise<boolean> {
    if (this.#session === undefined) {
      this.#startNewSession();
      this.#renderer.reset?.();
      return true;
    }
    try {
      await this.#session.reset();
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: `Couldn't reset the session: ${toErrorMessage(error)}`,
      });
      return false;
    }

    this.#startNewSession();
    this.#renderer.reset?.();
    return true;
  }

  async #readPromptWithIdleRefresh(options: AgentTUISessionOptions): Promise<string | undefined> {
    if (!this.#renderer.readPrompt) {
      return undefined;
    }

    const prompt = this.#renderer.readPrompt(options);
    const runtimeArtifacts = this.#runtimeArtifacts;
    if (runtimeArtifacts === undefined) {
      return await prompt;
    }

    let stopped = false;
    let refreshing = false;
    let inFlightRefresh: Promise<void> | undefined;
    let agentInfoRefreshPending = false;
    let lastChatGptAuthRefresh = 0;
    const refresh = async () => {
      if (stopped || refreshing) {
        return;
      }

      refreshing = true;
      try {
        await runtimeArtifacts.refreshIdle({
          onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
        });
        if (
          this.#appRoot !== undefined &&
          this.#agentInfo === undefined &&
          !agentInfoRefreshPending
        ) {
          agentInfoRefreshPending = true;
          void this.#refreshAgentInfo().finally(() => {
            agentInfoRefreshPending = false;
          });
        }
        const endpoint = this.#agentInfo?.agent.model.endpoint;
        const shouldRefreshChatGptAuth =
          endpoint?.kind === "chatgpt" &&
          (endpoint.state === "signed-out" || endpoint.state === "reauth-required");
        const now = Date.now();
        if (shouldRefreshChatGptAuth && now - lastChatGptAuthRefresh >= idleChatGptAuthPollMs) {
          lastChatGptAuthRefresh = now;
          void this.#refreshAgentInfo();
        }
      } finally {
        refreshing = false;
      }
    };

    const startRefresh = () => {
      if (stopped || refreshing) {
        return;
      }

      const nextRefresh = refresh().finally(() => {
        if (inFlightRefresh !== nextRefresh) {
          return;
        }
        inFlightRefresh = undefined;
      });
      inFlightRefresh = nextRefresh;
    };

    startRefresh();
    const timer = setInterval(() => {
      startRefresh();
    }, idleRuntimeArtifactPollMs);
    timer.unref?.();

    try {
      return await prompt;
    } finally {
      stopped = true;
      clearInterval(timer);
      await inFlightRefresh;
    }
  }

  /**
   * Gives the idle prompt exclusive ownership handoff with `send()`:
   * follow while the prompt is open, then abort and await the follow before
   * returning the submitted prompt. Both readers advance the same session
   * cursor, so the next send starts after every wake event already rendered.
   */
  async #readPromptFollowingSession(options: AgentTUISessionOptions): Promise<string | undefined> {
    const prompt = this.#readPromptWithIdleRefresh(options);
    if (
      this.#renderer.renderIdleStream === undefined ||
      this.#session?.state.sessionId === undefined
    ) {
      return await prompt;
    }

    const controller = new AbortController();
    const follow = this.#followIdleSession(controller.signal, options).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.#renderer.renderNotice?.(
          `Stopped following session updates: ${toErrorMessage(error)}`,
        );
      }
    });
    try {
      return await prompt;
    } finally {
      controller.abort();
      await follow;
    }
  }

  /**
   * Holds one boundary-blind parent stream open, splitting it into complete
   * turns for rendering. The underlying iterator stays shared across those
   * turns and advances the ClientSession cursor once it is stopped.
   */
  async #followIdleSession(signal: AbortSignal, options: AgentTUISessionOptions): Promise<void> {
    const sourceSession = this.#session;
    if (sourceSession === undefined) return;
    let reconnectDelayMs = idleSessionReconnectBaseDelayMs;
    while (!signal.aborted) {
      const source = sourceSession.stream({ signal })[Symbol.asyncIterator]();
      let deliveredEvent = false;
      try {
        while (!signal.aborted) {
          let consumed = false;
          const turn = {
            async *[Symbol.asyncIterator]() {
              while (!signal.aborted) {
                const next = await source.next();
                if (next.done === true) return;
                consumed = true;
                deliveredEvent = true;
                yield next.value;
                if (isCurrentTurnBoundaryEvent(next.value)) return;
              }
            },
          };
          const result = this.#createTUIStreamResult(turn, () => {}, sourceSession);
          await this.#renderer.renderIdleStream!(result, {
            ...options,
            continueSession: true,
          });
          this.#enterPendingConnectionAuthorization(result);
          if (
            (result.turnState?.pendingApprovals.length ?? 0) > 0 ||
            (result.turnState?.pendingQuestions.length ?? 0) > 0
          ) {
            this.#idleInputResult = {
              events: (async function* () {})(),
              turnState: result.turnState,
            };
            this.#renderer.suspendPromptForInput?.();
            return;
          }
          if (
            result.turnState?.boundaryEvent === "session.completed" ||
            result.turnState?.boundaryEvent === "session.failed"
          ) {
            return;
          }
          if (!consumed) break;
        }
      } finally {
        await source.return?.();
      }
      reconnectDelayMs = deliveredEvent
        ? idleSessionReconnectBaseDelayMs
        : Math.min(reconnectDelayMs * 2, idleSessionReconnectMaxDelayMs);
      if (!signal.aborted) await abortableDelay(reconnectDelayMs, signal);
    }
  }

  async #streamTurn(input: {
    prompt: string | undefined;
    inputResponses: readonly InputResponse[] | undefined;
  }): Promise<AgentTUIStreamResult> {
    // Backs the result's `abort`: lifecycle interruption fires it so the
    // in-flight stream read settles instead of dangling until server close.
    const abortController = new AbortController();
    const sendInput: {
      message?: string;
      inputResponses?: readonly InputResponse[];
      signal?: AbortSignal;
    } = { signal: abortController.signal };
    if (input.prompt !== undefined) sendInput.message = input.prompt;
    if (input.inputResponses !== undefined && input.inputResponses.length > 0) {
      sendInput.inputResponses = input.inputResponses;
    }

    let response: Awaited<ReturnType<ClientSession["send"]>>;
    const sourceSession = this.#session;
    try {
      if (this.#runtimeArtifacts !== undefined) {
        await this.#runtimeArtifacts.refresh({
          inputResponses: sendInput.inputResponses,
          message: sendInput.message,
          onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
        });
      }

      if (sendInput.message !== undefined && (sendInput.inputResponses?.length ?? 0) === 0) {
        this.#renderer.flushDelayedDevBuildErrors?.();
      }

      if (this.#session === undefined) {
        if (this.#client === undefined) {
          throw new Error("Cannot create a session without an eve client.");
        }
        if (sendInput.message === undefined) {
          throw new Error("Cannot answer an input request before the session starts.");
        }
        const created = await this.#client.sessions.create({
          ...sendInput,
          message: sendInput.message,
        });
        this.#session = created.session;
        response = created.response;
      } else {
        response =
          sendInput.inputResponses === undefined
            ? await this.#session.send(sendInput.message!, {
                signal: sendInput.signal,
                turnPolicy: "queue",
              })
            : await this.#session.respond(sendInput.inputResponses, { signal: sendInput.signal });
      }
    } catch (error) {
      if (isInterruptedError(error)) throw error;
      // Dispatching the turn failed before any stream opened (transport
      // error, auth challenge, …). Surface it through the same error path
      // as in-stream failures so it renders as an inline region right
      // where the assistant response would have appeared, then let the
      // loop recover onto a fresh session before the next prompt.
      this.#remoteConnection?.reportFailure(error);
      this.#failedSession = sourceSession;
      return {
        events: errorOnlyTUIStream({
          errorText: this.#formatTransportError(error),
        }),
        turnState: createTurnState(),
      };
    }

    return this.#createTUIStreamResult(response, () => abortController.abort(), this.#session);
  }

  /**
   * Requests cooperative cancellation of the streaming turn and retries
   * while the turn stays live. A key-driven cancel that lands before the owner
   * begins the turn (i.e. before `turn.started` reaches the client) resolves as a
   * benign `no_active_turn` and would otherwise be silently lost, leaving
   * the TUI showing "Cancelling…" while the turn runs to completion.
   * Retrying until the stream reaches its boundary closes that window.
   *
   * Once `turn.started` names the turn, each retry carries its id, so a
   * GUARDED retry that outlives the boundary is a benign no-op. An
   * UNGUARDED attempt (turnId not yet known) has a residual race: if this
   * turn's boundary, the queue drain, and the next turn's dispatch all
   * complete while the request is in flight, the cancel can land on the
   * next turn. Closing it needs turn-scoped cancel admission server-side
   * (the #867 ledger); until then the renderer backstops it — a
   * `turn.cancelled` arriving without a local cancel request in that stream
   * restores the submitted message into the prompt instead of losing it.
   * Single-flight per turn: repeated cancel keys join the running loop.
   */
  async #requestTurnCancellation(
    turnState: AgentTUITurnState,
    sourceSession: ClientSession | undefined,
  ): Promise<void> {
    if (turnState.cancelInFlight === true) return;
    turnState.cancelInFlight = true;
    try {
      for (let attempt = 0; attempt < turnCancelAttempts; attempt += 1) {
        if (turnState.boundaryEvent !== undefined || turnState.aborted === true) return;
        const turnId = turnState.turnId;
        try {
          const result = await sourceSession?.cancel(turnId === undefined ? undefined : { turnId });
          // Accepted means the turn's cancellation hook consumed the
          // request; the turn settles at its next safe boundary.
          if (result?.status === "accepted") return;
        } catch {
          // No accepted session yet or a transport failure — retry below;
          // lifecycle interruption remains the hard client-side escape hatch.
        }
        await delayMs(turnCancelRetryDelayMs);
      }
    } finally {
      turnState.cancelInFlight = false;
    }
  }

  /** Follows the current session without dispatching another turn. */
  #streamCurrentSession(): AgentTUIStreamResult {
    if (this.#session === undefined) {
      throw new Error("Cannot stream a session before its first turn is accepted.");
    }
    const abortController = new AbortController();
    const sourceSession = this.#session;
    return this.#createTUIStreamResult(
      sourceSession.stream({ signal: abortController.signal }),
      () => abortController.abort(),
      sourceSession,
    );
  }

  #createTUIStreamResult(
    events: AsyncIterable<MessageStreamEvent>,
    abort: () => void,
    sourceSession: ClientSession | undefined,
  ): AgentTUIStreamResult {
    const turnState = createTurnState();
    const steering =
      sourceSession === undefined ? undefined : new SteeringStream(events, sourceSession);
    return {
      steer: steering === undefined ? undefined : (message) => steering.send(message),
      abort: () => {
        turnState.aborted = true;
        this.#failedSession = sourceSession;
        steering?.abort();
        abort();
      },
      cancel: () => {
        void this.#requestTurnCancellation(turnState, sourceSession);
      },
      events: eveEventsToTUIStream({
        onAssistantResponse: () => {
          if (this.#onboard && !this.#reportedFirstResponse) {
            this.#reportedFirstResponse = true;
            this.#onOnboardingStep?.({ flow: "onboarding", step: "first_response" });
          }
        },
        events: steering ?? events,
        getConversation: () => this.#conversation,
        seenEvents: this.#seenEvents,
        onConversationChange: (state) => {
          this.#conversation = state;
        },
        turnState,
        onSubagentEvent: (event) => {
          this.#childStreamFollower.acceptParentEvent(event);
          this.#childStreamFollower.reconcile();
          if (event.type === "subagent.called")
            this.#subagentProjection?.update(this.#conversation, event.data.callId);
          if (event.type === "subagent.completed" || event.type === "action.result") {
            const callId =
              event.type === "subagent.completed" ? event.data.callId : event.data.result.callId;
            this.#subagentProjection?.update(this.#conversation, callId);
          }
          if (event.type === "turn.cancelled") {
            for (const call of Object.values(this.#conversation.children)) {
              if (call.originTurnId === event.data.turnId)
                this.#subagentProjection?.update(this.#conversation, call.callId);
            }
          }
        },
        onConnectionAuthRequired: (event) => this.#handleConnectionAuthRequired(event),
        onConnectionAuthCompleted: (event) => this.#handleConnectionAuthCompleted(event),
        onRegistryHandoff:
          this.#appRoot === undefined
            ? undefined
            : async (address) => this.#queueRegistrySetup(address),
        onTerminalFailure: () => {
          this.#failedSession = sourceSession;
        },
        failureHintOverride: this.#appRoot === undefined ? undefined : localFailureHint,
      }),
      turnState,
    };
  }

  #queueRegistrySetup(address: string): void {
    if (this.#activeRegistrySetup === address || this.#pendingRegistrySetups.includes(address)) {
      return;
    }
    this.#pendingRegistrySetups.push(address);
    if (this.#readingPrompt) this.#renderer.suspendPromptForInput?.();
  }

  async #openRegistrySetup(address: string): Promise<void> {
    this.#renderer.renderCommandInvocation?.(`/add ${address}`);
    await this.#executeExtensionCommand(
      { type: "extension", name: "add", argument: address },
      "Add to your agent",
      { trigger: "command" },
    );
  }

  async #renderSetupIssues(info: AgentInfoResult | undefined): Promise<void> {
    if (this.#appRoot === undefined) return;
    const context: BootDetectionContext = {
      appRoot: this.#appRoot,
      env: process.env,
    };
    if (info !== undefined) context.info = info;
    this.#bootIssues = await detectSetupIssues(context, this.#bootDetections);
    if (this.#renderer.renderSetupWarning === undefined) return;
    this.#paintSetupAttention();
    // Login state is a `vercel whoami` round-trip — too costly for the
    // cheap-and-local boot detections above — so it rides its own probe off
    // the critical path and never delays the first prompt.
    this.#probeAuthIssue();
  }

  /** Repaints the attention line from the cached detection + auth issues, or clears it. */
  #paintSetupAttention(): void {
    if (this.#startupActive) return;
    const issues = orderedSetupIssues(this.#bootIssues, this.#authIssue);
    if (issues.length > 0) {
      this.#renderer.renderSetupWarning?.(formatSetupIssuesLine(issues));
    } else {
      this.#renderer.clearSetupWarning?.();
    }
  }

  /** Checks Vercel auth after boot without delaying the first prompt. */
  async #probeAuthIssue(): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined || process.env.EVE_MODEL_CONNECTION !== "ai-gateway-project") return;
    let status: VercelAuthStatus;
    try {
      status = await this.#getVercelAuthStatus(appRoot, { signal: this.#authProbeAbort.signal });
    } catch {
      return;
    }
    if (this.#disposed || this.#authHintStale) return;
    this.#authIssue = authIssueForStatus(status);
    this.#paintSetupAttention();
  }

  /**
   * Re-evaluates the attention line after a setup command changed local state,
   * so a fixed issue clears (e.g. the `not logged in · /deploy` line disappears
   * once `/deploy` succeeds) instead of lingering stale. Authoritative: unlike
   * the boot probe it re-reads detections and auth and is not stale-guarded.
   */
  async #refreshSetupAttention(info: AgentInfoResult | undefined): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) return;
    if (this.#renderer.renderSetupWarning === undefined) return;
    const revision = ++this.#setupAttentionRevision;
    const context: BootDetectionContext = { appRoot, env: process.env };
    if (info !== undefined) context.info = info;
    try {
      const [issues, auth] = await Promise.all([
        detectSetupIssues(context, this.#bootDetections),
        process.env.EVE_MODEL_CONNECTION === "ai-gateway-project"
          ? this.#getVercelAuthStatus(appRoot, { signal: this.#authProbeAbort.signal })
          : undefined,
      ]);
      if (this.#disposed || revision !== this.#setupAttentionRevision) return;
      this.#bootIssues = issues;
      this.#authIssue = auth === undefined ? undefined : authIssueForStatus(auth);
      this.#paintSetupAttention();
    } catch {
      return;
    }
  }

  #finishCommand(outcome: CommandPresentation): void {
    if (this.#renderer.finishCommand !== undefined) {
      this.#renderer.finishCommand(outcome);
      return;
    }
    if (outcome.kind === "result") {
      const notice = [outcome.summary, outcome.message].filter(Boolean).join("\n");
      if (notice !== "") this.#renderer.renderNotice?.(notice);
    }
  }

  async #handleExtensionCommand(
    command: Extract<PromptCommand, { type: "extension" }>,
    input: Pick<PromptCommandHandlerContext, "initialModelStep" | "title">,
  ): Promise<PromptCommandOutcome | undefined> {
    const handler = this.#promptCommandHandler;
    if (handler === undefined)
      return { message: `/${command.name} is not available in this session.` };

    const endpoint = this.#agentInfo?.agent.model.endpoint;
    const baseContext: PromptCommandHandlerContext = {
      ...input,
      renderer: this.#renderer,
      settleOutcome: (outcome) => this.#settleCommandOutcome(outcome),
      chatGptAccountLabel:
        endpoint?.kind === "chatgpt" && endpoint.state === "ready"
          ? endpoint.accountLabel
          : undefined,
      withExclusiveTerminal: this.#withExclusiveTerminal,
    };
    const disabledConnectionReasons = this.#mcpConnectionStatus?.current();
    const context: PromptCommandHandlerContext =
      disabledConnectionReasons !== undefined && Object.keys(disabledConnectionReasons).length > 0
        ? { ...baseContext, disabledConnectionReasons }
        : baseContext;
    return await handler.handle(command, context);
  }

  async #applyCommandEffect(effect: PromptCommandOutcome["effect"]): Promise<void> {
    if (effect?.kind === "model-access-changed") {
      this.#vercelStatus?.applyEffect({ kind: "refresh-identity" });
      this.#authHintStale = true;
      await this.#refreshModelAccess(effect);
      return;
    }
    if (effect === undefined) return;

    this.#vercelStatus?.applyEffect(effect);
    this.#authHintStale = true;
    void this.#refreshSetupAttention(this.#agentInfo);
  }

  async #settleCommandOutcome(outcome: PromptCommandOutcome): Promise<PromptCommandOutcome> {
    if (outcome.effect === undefined) return outcome;
    const refreshTimer =
      outcome.effect.kind === "model-access-changed" && outcome.effect.reload
        ? setTimeout(() => {
            if (this.#startupActive) this.#renderer.setStartupPhase?.("updating");
            this.#renderer.setupFlow?.setStatus("Loading selected model…");
          }, 150)
        : undefined;
    try {
      await this.#applyCommandEffect(outcome.effect);
      const { effect: _effect, ...settled } = outcome;
      return settled;
    } catch {
      return {
        failed: true,
        message:
          "Settings were saved, but the agent could not reload. Retry the command or restart eve dev.",
      };
    } finally {
      clearTimeout(refreshTimer);
    }
  }

  async #executeExtensionCommand(
    command: Extract<PromptCommand, { type: "extension" }>,
    title: string,
    input: {
      readonly trigger: "startup" | "command";
      readonly initialModelStep?: "provider";
      readonly onOnboardingScreen?: PromptCommandHandlerContext["onOnboardingScreen"];
      readonly suppressSuccessfulTranscript?: true;
      readonly suppressCancelledTranscript?: true;
    },
  ): Promise<PromptCommandOutcome | undefined> {
    const pendingOutcome = await this.#handleExtensionCommand(command, { ...input, title });
    const outcome =
      pendingOutcome === undefined ? undefined : await this.#settleCommandOutcome(pendingOutcome);
    const suppressTranscript =
      (input.suppressSuccessfulTranscript === true && outcome?.failed !== true) ||
      (input.suppressCancelledTranscript === true && outcome?.cancelled === true);
    if (!suppressTranscript && input.trigger !== "startup") {
      if (outcome === undefined) this.#finishCommand({ kind: "result" });
      else
        this.#finishCommand({ kind: "result", message: outcome.message, summary: outcome.summary });
    }
    this.#refreshHeaderFromRemoteConnection();
    return outcome;
  }

  async #runInitialAgentOnboarding(title: string): Promise<PromptCommandOutcome | undefined> {
    this.#onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
    const outcome = await this.#executeExtensionCommand(
      { type: "extension", name: "login", argument: "" },
      title,
      { trigger: "startup", initialModelStep: "provider" },
    );
    if (!outcome?.cancelled && outcome?.failed !== true)
      this.#onOnboardingStep?.({ flow: "onboarding", step: "connection_ready" });
    this.#onOnboardingTerminal?.({
      flow: "onboarding",
      step: "model_provider",
      result: outcome?.cancelled ? "cancelled" : outcome?.failed === true ? "error" : "completed",
    });
    return outcome;
  }

  #refreshHeaderFromRemoteConnection(): void {
    if (this.#startupActive) return;
    const connection = this.#remoteConnection?.current().connection;
    if (connection?.state !== "ready" || connection.info === this.#agentInfo) return;
    this.#agentInfo = connection.info;
    if (this.#serverUrl === undefined) return;
    this.#renderer.renderAgentHeader?.({
      info: connection.info,
      name: this.#name,
      serverUrl: this.#serverUrl,
    });
  }

  /**
   * Opens the renderer's trace viewer on the local spool. The viewer owns the
   * screen until the user closes it; sessions without the capability (or
   * without a local app root) get a one-line notice instead.
   */
  async #openTraceViewer(argument: string): Promise<void> {
    if (this.#appRoot === undefined || this.#renderer.traceViewer === undefined) {
      this.#finishCommand({
        kind: "result",
        message: "/traces is only available in local dev sessions.",
      });
      return;
    }
    try {
      await this.#renderer.traceViewer.open({
        appRoot: this.#appRoot,
        sessionId: this.#session?.state.sessionId,
        reference: argument === "" ? undefined : argument,
      });
    } catch (error) {
      if (isInterruptedError(error)) return;
      throw error;
    } finally {
      this.#finishCommand({ kind: "dismiss" });
    }
  }

  async #showApplicationInfo(): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) {
      this.#finishCommand({
        kind: "result",
        message: "/info is only available in local dev sessions.",
      });
      return;
    }
    try {
      const info = renderApplicationInfo(await this.#inspectApplication(appRoot));
      if (this.#renderer.showInfoPanel !== undefined) await this.#renderer.showInfoPanel(info);
      else this.#finishCommand({ kind: "result", message: info });
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: `Couldn't inspect the application: ${toErrorMessage(error)}`,
      });
    }
  }

  /**
   * Applies `/loglevel [all|stderr|sandbox|none]` against the renderer's buffered
   * log filter and returns the one-line outcome. A bare `/loglevel` reports
   * the current mode instead of changing it.
   */
  #applyLogLevelCommand(argument: string): string {
    const renderer = this.#renderer;
    if (renderer.logDisplayMode === undefined || renderer.setLogDisplayMode === undefined) {
      return "/loglevel is not available in this session.";
    }
    if (argument === "") {
      return `Logs: ${renderer.logDisplayMode()}. Use /loglevel all|stderr|sandbox|none — logs stay buffered, so switching also hides or restores past lines.`;
    }
    const mode = parseLogDisplayMode(argument);
    if (mode === undefined) {
      return `Unknown log level "${argument}". Use all, stderr, sandbox, or none.`;
    }
    if (mode === renderer.logDisplayMode()) {
      return `Logs already set to ${mode}.`;
    }
    renderer.setLogDisplayMode(mode);
    switch (mode) {
      case "none":
        return "Logs hidden. Output stays buffered — /loglevel all restores it.";
      case "stderr":
        return "Showing stderr logs only.";
      case "sandbox":
        return "Showing sandbox logs only.";
      case "all":
        return "Showing all logs.";
    }
  }

  async #refreshModelAccess(effect: ModelAccessChange): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) return;
    // Invalidate inspections started before this selection, including watcher notifications.
    ++this.#agentInfoRevision;
    ++this.#setupAttentionRevision;
    await loadDevelopmentEnvironmentFiles(appRoot);
    if (effect.reload) await this.#runtimeArtifacts?.refreshAfterSourceChange({});
    if (effect.model && this.#agentInfo) {
      this.#replaceAgentInfo({
        ...this.#agentInfo,
        agent: {
          ...this.#agentInfo.agent,
          model: { ...this.#agentInfo.agent.model, ...effect.model },
        },
      });
    } else this.#replaceAgentInfo(this.#agentInfo);
    this.#bootIssues = [];
    this.#authIssue = undefined;
    this.#paintSetupAttention();
    void this.#refreshAgentInfo();
  }

  async #refreshAgentInfo(notify = false): Promise<void> {
    const previousInfo = this.#agentInfo;
    const revision = ++this.#agentInfoRevision;
    const nextInfo = await this.#readAgentInfo();
    if (this.#disposed || revision !== this.#agentInfoRevision || nextInfo === undefined) return;
    this.#replaceAgentInfo(nextInfo);
    if (notify && !this.#renderer.renderAgentHeader)
      this.#renderer.renderNotice?.(formatAgentUpdateNotice(previousInfo, nextInfo));
    void this.#refreshSetupAttention(this.#agentInfo);
  }

  async #readAgentInfo(): Promise<AgentInfoResult | undefined> {
    const client = this.#client;
    if (client === undefined) return;

    const probe = await probeAgentInfo({ client });
    return probe.kind === "ready" ? probe.info : undefined;
  }

  #handleRuntimeArtifactsChanged(): void {
    void this.#refreshAgentInfo(true);
  }

  #handleConnectionAuthRequired(event: AuthorizationRequiredStreamEvent): void {
    const run: ConnectionAuthRun = {
      name: event.data.name,
      attemptId: event.data.attemptId,
      description: event.data.description,
      state: "required",
    };
    if (event.data.authorization !== undefined) {
      run.challenge = event.data.authorization;
    }
    if (event.data.webhookUrl !== undefined) {
      run.webhookUrl = event.data.webhookUrl;
    }
    this.#connectionAuthRuns.set(authorizationKey(event.data), run);
    this.#emitConnectionAuthUpdate(run);
  }

  /**
   * Marks framework-owned OAuth challenges as parked only after the current
   * turn has reached its `session.waiting` boundary. A `webhookUrl` is the
   * runtime's proof that a later callback turn can complete the challenge.
   */
  #enterPendingConnectionAuthorization(result: AgentTUIStreamResult): boolean {
    if (result.turnState?.boundaryEvent !== "session.waiting") {
      return false;
    }

    let added = false;
    for (const run of this.#connectionAuthRuns.values()) {
      if (run.state !== "required" || run.webhookUrl === undefined) continue;
      run.state = "pending";
      this.#pendingConnectionAuths.add(authorizationKey(run));
      this.#emitConnectionAuthUpdate(run);
      added = true;
    }

    if (added) {
      this.#renderer.setConnectionAuthPendingCount?.(this.#pendingConnectionAuths.size);
    }
    return this.#pendingConnectionAuths.size > 0;
  }

  #handleConnectionAuthCompleted(event: AuthorizationCompletedStreamEvent): void {
    const existing = this.#connectionAuthRuns.get(authorizationKey(event.data));
    const run: ConnectionAuthRun = existing ?? {
      name: event.data.name,
      attemptId: event.data.attemptId,
      description: "",
      state: event.data.outcome,
    };
    run.state = event.data.outcome;
    if (event.data.reason !== undefined) {
      run.reason = event.data.reason;
    }
    this.#connectionAuthRuns.set(authorizationKey(event.data), run);
    this.#pendingConnectionAuths.delete(authorizationKey(event.data));
    this.#emitConnectionAuthUpdate(run);
    this.#renderer.setConnectionAuthPendingCount?.(this.#pendingConnectionAuths.size);
  }

  #emitConnectionAuthUpdate(run: ConnectionAuthRun): void {
    const update: ConnectionAuthUpdate = {
      name: run.name,
      attemptId: run.attemptId,
      description: run.description,
      state: run.state,
    };
    if (run.challenge !== undefined) update.challenge = run.challenge;
    if (run.reason !== undefined) update.reason = run.reason;
    this.#renderer.upsertConnectionAuth?.(update);
  }
}

function createRenderer(options: EveTUIRunnerOptions): AgentTUIRenderer {
  if (options.renderer) {
    return options.renderer;
  }

  // `TerminalRenderer` defaults every omitted field, so explicit `undefined`s
  // are equivalent to leaving them out. Omitted input/output fall back to the
  // real process stdio.
  return new TerminalRenderer({
    tools: options.tools,
    reasoning: options.reasoning,
    subagents: options.subagents,
    connectionAuth: options.connectionAuth,
    assistantResponseStats: options.assistantResponseStats,
    contextSize: options.contextSize,
    logs: options.logs,
    availablePromptCommands: options.availablePromptCommands,
    argumentSuggestions: options.argumentSuggestions,
    input: options.userInput,
    output: options.screen,
    diagnostics: options.diagnostics,
    onExitRequest: options.lifecycle?.requestStop,
  });
}

function formatAgentUpdateNotice(
  previousInfo: AgentInfoResult | undefined,
  nextInfo: AgentInfoResult | undefined,
): string {
  const previousModel = previousInfo?.agent.model.id;
  const nextModel = nextInfo?.agent.model.id;

  if (previousModel !== undefined && nextModel !== undefined && previousModel !== nextModel) {
    return `Agent updated: Model ${previousModel} -> ${nextModel}`;
  }

  return "Agent updated.";
}

type EveStreamTranslatorInput = {
  events: AsyncIterable<MessageStreamEvent>;
  onAssistantResponse?: () => void;
  getConversation: () => ConversationState;
  seenEvents: EventDeduper;
  onConversationChange: (state: ConversationState) => void;
  turnState: AgentTUITurnState;
  onSubagentEvent?: (event: MessageStreamEvent) => void;
  onConnectionAuthRequired?: (event: AuthorizationRequiredStreamEvent) => void;
  onConnectionAuthCompleted?: (event: AuthorizationCompletedStreamEvent) => void;
  /** Opens a setup-bearing registry item in the existing `/add` flow. */
  onRegistryHandoff?: (address: string) => Promise<void>;
  onTerminalFailure?: (event: SessionFailedStreamEvent) => void;
  /**
   * Replaces a failure's structured hint with a surface-local one (the
   * local TUI swaps gateway-auth remediation for the in-session `/model`
   * fix). Returning `undefined` keeps the hint the harness attached.
   */
  failureHintOverride?: (event: FailureStreamEvent) => string | undefined;
};

/** Returns the registry address carried by a packaged self-modification terminal handoff. */
export function registryHandoffAddress(
  subagentName: string | undefined,
  toolName: string | undefined,
  output: unknown,
): string | undefined {
  const isPackagedChild =
    subagentName === "self-modification__agent" && toolName === "registry_add";
  const isLegacyRoot = subagentName === undefined && toolName === "selfmod__registry_add";
  if ((!isPackagedChild && !isLegacyRoot) || typeof output !== "object" || output === null) {
    return undefined;
  }
  const result = output as { address?: unknown; status?: unknown };
  return result.status === "needs-terminal" && typeof result.address === "string"
    ? result.address
    : undefined;
}

/**
 * Reduces one eve session-stream turn into renderer-native TUI events.
 * eve events name assistant/reasoning sections by `turnId` + `stepIndex`;
 * those ids become stable block ids in the terminal renderer.
 */
async function* eveEventsToTUIStream(
  input: EveStreamTranslatorInput,
): AsyncIterable<AgentTUIStreamEvent> {
  const {
    events,
    getConversation,
    seenEvents,
    onConversationChange,
    turnState,
    onSubagentEvent,
    onConnectionAuthRequired,
    onConnectionAuthCompleted,
    onRegistryHandoff,
    onTerminalFailure,
    failureHintOverride,
  } = input;
  const reducer = conversationReducer;
  const messageProjection = new TerminalMessageProjection();
  messageProjection.restore(getConversation());

  // The harness reports one underlying failure as a cascade (`step.failed` →
  // `turn.failed` → `session.failed`) with an identical payload on each
  // event. Render it once, not three times.
  const emittedFailures = new Set<string>();
  let sentFinish = false;
  let visibleTurnCompleted = false;
  let latestStepUsage: StepCompletedStreamEvent["data"]["usage"] | undefined;

  for await (const event of events) {
    if (!seenEvents.admit(event)) {
      continue;
    }

    if (visibleTurnCompleted && isPostTurnVisibleEvent(event)) {
      continue;
    }

    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind === "tool-call") messageProjection.announceTool(action.callId);
      }
    } else if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        if (request.action.kind === "tool-call" && request.kind !== "session-limit") {
          messageProjection.announceTool(request.action.callId);
        }
      }
    }
    if (event.type === "turn.started") {
      if (event.data.turnId !== turnState.turnId) visibleTurnCompleted = false;
      turnState.turnId = event.data.turnId;
      yield { type: "turn-start", turnId: event.data.turnId };
    } else if (event.type === "step.started") {
      yield { type: "step-start", modelId: event.data.modelId };
    }
    const previous = getConversation();
    const messageData = reducer.reduce(previous, event);
    if (messageData !== previous) {
      onConversationChange(messageData);
      if (
        event.type === "subagent.called" ||
        event.type === "subagent.completed" ||
        event.type === "action.result" ||
        event.type === "turn.cancelled"
      ) {
        onSubagentEvent?.(event);
      }
      for (const update of messageProjection.transition(messageData)) {
        if (update.type === "assistant-delta") input.onAssistantResponse?.();
        yield update;
      }
      yield* messageProjection.toolTransitions(messageData);
    }
    const openInputs = openConversationInputs(messageData);
    turnState.pendingApprovals = openInputs
      .filter((input) => input.request.kind === "tool-approval")
      .map((input) => toAgentTUIToolApprovalRequest(input.request));
    turnState.pendingQuestions = openInputs
      .filter((input) => input.request.kind !== "tool-approval")
      .map((input) => input.request);

    switch (event.type) {
      case "session.started":
      case "message.received":
        // Boundary / metadata events with no direct UI surface.
        break;

      case "turn.started":
      case "step.started":
        break;

      case "step.completed": {
        const stepEvent = event as StepCompletedStreamEvent;
        latestStepUsage = stepEvent.data.usage;
        yield { type: "step-finish", usage: stepEvent.data.usage };
        break;
      }

      case "message.appended":
      case "message.completed":
      case "reasoning.appended":
      case "reasoning.completed":
        break;

      case "actions.requested":
        break;

      case "input.requested":
      case "approval.settled":
      case "input.resolved":
        // The conversation ledger owns request identity and closure.
        break;

      case "approval.candidate": {
        if (event.data.outcome === "pending") break;
        const request = pendingInputRequests.get(event.data.requestId);
        if (request !== undefined) upsertPendingApproval(turnState, request);
        break;
      }

      case "approval.settled":
      case "input.resolved": {
        const requestIds = new Set(
          event.type === "input.resolved"
            ? event.data.resolutions.map((resolution) => resolution.requestId)
            : [event.data.requestId],
        );
        for (const requestId of requestIds) pendingInputRequests.delete(requestId);
        turnState.pendingApprovals = turnState.pendingApprovals.filter(
          (request) => !requestIds.has(request.approvalId),
        );
        turnState.pendingQuestions = turnState.pendingQuestions.filter(
          (request) => !requestIds.has(request.requestId),
        );
        break;
      }

      case "action.result": {
        const resultEvent = event as ActionResultStreamEvent;
        if (
          resultEvent.data.result.kind === "tool-result" &&
          resultEvent.data.status === "completed"
        ) {
          const tool = messageData.messages
            .flatMap((message) => message.parts)
            .find(
              (part) =>
                part.type === "dynamic-tool" && part.toolCallId === resultEvent.data.result.callId,
            );
          if (messageProjection.hasTool(resultEvent.data.result.callId)) {
            const address = registryHandoffAddress(
              undefined,
              tool?.type === "dynamic-tool" ? tool.toolName : undefined,
              resultEvent.data.result.output,
            );
            if (address !== undefined) await onRegistryHandoff?.(address);
          }
        }
        break;
      }

      case "step.failed":
      case "turn.failed": {
        const failure = toFailureEvent(event, emittedFailures, failureHintOverride);
        if (failure) yield failure;
        break;
      }

      case "session.failed": {
        // Terminal: the server session is dead. Flag the runner so it can
        // recover onto a fresh session before the next prompt.
        turnState.sawSessionFailure = true;
        onTerminalFailure?.(event as SessionFailedStreamEvent);
        const failure = toFailureEvent(event, emittedFailures, failureHintOverride);
        if (failure) yield failure;
        turnState.boundaryEvent = event.type;
        yield {
          type: "finish",
          usage: latestStepUsage,
        };
        sentFinish = true;
        return;
      }

      case "session.waiting":
      case "session.completed":
        turnState.boundaryEvent = event.type;
        yield {
          type: "finish",
          usage: latestStepUsage,
        };
        sentFinish = true;
        return;

      case "turn.completed":
        visibleTurnCompleted = true;
        break;

      case "turn.cancelled":
        // Explicit cooperative cancellation preserves the session.
        // `session.waiting` follows and finishes the stream normally.
        yield { type: "turn-cancelled" };
        break;

      case "subagent.called":
        break;

      case "subagent.started":
      case "subagent.event":
        // `subagent.started` and `subagent.event` are not emitted by the
        // current harness — the parent stream only sees `called` and
        // `completed`. All intermediate child content is observed via
        // the runner's parallel child-stream follower.
        break;

      case "subagent.completed":
        break;

      case "authorization.required":
        onConnectionAuthRequired?.(event as AuthorizationRequiredStreamEvent);
        break;

      case "authorization.completed":
        onConnectionAuthCompleted?.(event as AuthorizationCompletedStreamEvent);
        break;

      default:
        // compaction.* — ignored for v1.
        break;
    }
  }

  if (!sentFinish) {
    yield* messageProjection.finish();
    yield { type: "finish", usage: latestStepUsage };
  }
}

/**
 * A single-turn stream that carries only an error. Used when dispatching
 * the turn throws before any real stream opens, so the failure flows
 * through the renderer's normal error path and renders as one inline
 * region in transcript order.
 */
async function* errorOnlyTUIStream(input: {
  errorText: string;
}): AsyncIterable<AgentTUIStreamEvent> {
  yield { type: "error", errorText: input.errorText };
  yield { type: "finish" };
}

function createTurnState(): AgentTUITurnState {
  return {
    aborted: false,
    pendingApprovals: [],
    pendingQuestions: [],
    sawSessionFailure: false,
  };
}

function toAgentTUIToolApprovalRequest(request: InputRequest): AgentTUIToolApprovalRequest {
  return {
    approvalId: request.requestId,
    toolCallId: request.action.callId,
    toolName: request.action.toolName,
    input: request.action.input,
  };
}

function isPostTurnVisibleEvent(event: MessageStreamEvent): boolean {
  switch (event.type) {
    case "actions.requested":
    case "authorization.completed":
    case "authorization.required":
    case "input.requested":
    case "message.appended":
    case "message.completed":
    case "reasoning.appended":
    case "reasoning.completed":
    case "result.completed":
    case "step.completed":
    case "step.failed":
    case "step.started":
    case "subagent.called":
    case "subagent.completed":
    case "subagent.event":
    case "subagent.started":
    case "turn.completed":
    case "turn.failed":
      return true;
    default:
      return false;
  }
}

/**
 * Projects one failure event into a renderable `error` stream event, or
 * `undefined` when the same underlying failure was already emitted earlier in
 * the cascade. Carries the failure as a structured entity: headline, the
 * catalog's remediation hint (surface overrides win), and the diagnostic
 * dump when the failure carries one — i.e. for unrecognized errors escaping
 * user code.
 */
function toFailureEvent(
  event: FailureStreamEvent,
  emittedFailures: Set<string>,
  failureHintOverride?: (event: FailureStreamEvent) => string | undefined,
): AgentTUIStreamEvent | undefined {
  const key = failureKey(event);
  if (emittedFailures.has(key)) return undefined;
  emittedFailures.add(key);

  const failure: AgentTUIStreamEvent = {
    type: "error",
    errorText: formatFailureMessage(event),
  };
  const hint = failureHintOverride?.(event) ?? formatFailureHint(event);
  if (hint !== undefined) failure.hint = hint;
  const detail = formatFailureDetail(event);
  if (detail !== undefined) failure.detail = detail;
  return failure;
}

function toAgentTUIInputQuestion(request: InputRequest): AgentTUIInputQuestion {
  const display: "select" | "text" =
    request.display === "text"
      ? "text"
      : request.display === "select"
        ? "select"
        : request.options !== undefined && request.options.length > 0
          ? "select"
          : "text";

  const question: AgentTUIInputQuestion = {
    requestId: request.requestId,
    prompt: request.prompt,
    display,
  };

  if (request.options !== undefined) {
    question.options = request.options.map((option: InputOption) => {
      const out: AgentTUIInputOption = { id: option.id, label: option.label };
      if (option.description !== undefined) out.description = option.description;
      if (option.style !== undefined) out.style = option.style;
      return out;
    });
  }

  if (request.allowFreeform !== undefined) {
    question.allowFreeform = request.allowFreeform;
  }

  return question;
}

export type ConnectionAuthChallenge = {
  url?: string;
  userCode?: string;
  expiresAt?: string;
  instructions?: string;
};

export type ConnectionAuthState = "required" | "pending" | ConnectionAuthorizationOutcome;

export type ConnectionAuthUpdate = {
  name: string;
  attemptId?: string;
  description: string;
  state: ConnectionAuthState;
  challenge?: ConnectionAuthChallenge;
  reason?: string;
};

type ConnectionAuthRun = {
  name: string;
  attemptId?: string;
  description: string;
  state: ConnectionAuthState;
  challenge?: ConnectionAuthChallenge;
  webhookUrl?: string;
  reason?: string;
};
