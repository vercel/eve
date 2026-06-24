import {
  type ActionResultStreamEvent,
  type ActionsRequestedStreamEvent,
  type AgentInfoResult,
  type AuthorizationCompletedStreamEvent,
  type ConnectionAuthorizationOutcome,
  type AuthorizationRequiredStreamEvent,
  type HandleMessageStreamEvent,
  type InputOption,
  type InputRequest,
  type InputRequestedStreamEvent,
  type InputResponse,
  type MessageAppendedStreamEvent,
  type ReasoningAppendedStreamEvent,
  type SessionFailedStreamEvent,
  type StepCompletedStreamEvent,
  type SubagentCalledStreamEvent,
  type SubagentCompletedStreamEvent,
  Client,
  ClientSession,
  isCurrentTurnBoundaryEvent,
} from "#client/index.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { subscribeDevelopmentSandboxPrewarmLogs } from "#execution/sandbox/development-prewarm.js";
import {
  createDevelopmentRuntimeArtifactSessionRefresher,
  type DevelopmentRuntimeArtifactSessionRefresher,
} from "#services/dev-client.js";
import { toErrorMessage } from "#shared/errors.js";
import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";

import {
  type FailureStreamEvent,
  failureKey,
  formatFailureDetail,
  formatFailureMessage,
  formatGatewayAuthFailureNotice,
  isAbortLikeError,
  isGatewayAuthFailure,
  isInterruptedError,
} from "./errors.js";

import { pickAgentHeaderTip } from "./agent-header.js";
import { parseLogDisplayMode } from "./log-display-mode.js";
import {
  formatPromptCommandHelp,
  parsePromptCommand,
  PROMPT_COMMANDS,
  type PromptCommand,
  type PromptCommandSpec,
} from "./prompt-commands.js";
import {
  createRemoteConnectionController,
  type RemoteConnectionController,
  type RemoteConnectionControllerOptions,
  type RemoteConnectionSnapshot,
} from "./remote-connection.js";
import type { DevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  BOOT_DETECTIONS,
  CLI_MISSING_SETUP_ISSUE,
  automaticSetupCommand,
  detectSetupIssues,
  formatSetupIssuesLine,
  LOGIN_SETUP_ISSUE,
  orderedSetupIssues,
  resolveModelProviderState,
  type BootDetection,
  type BootDetectionContext,
  type SetupIssue,
} from "./setup-issues.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
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
import type { detectProjectIdentity } from "#setup/project-resolution.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "#setup/vercel-project.js";

export { parsePromptCommand, type PromptCommand } from "./prompt-commands.js";

const defaultAssistantResponseStats: AssistantResponseStatsMode = "tokensPerSecond";
const idleRuntimeArtifactPollMs = 500;

export type AgentTUIStreamResult = {
  events: AsyncIterable<AgentTUIStreamEvent> | ReadableStream<AgentTUIStreamEvent>;
  abort?: () => void;
  turnState?: AgentTUITurnState;
};

export type AgentTUIStreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type AgentTUIStreamEvent =
  | { type: "step-start" }
  | { type: "step-finish"; usage?: AgentTUIStreamUsage }
  | { type: "assistant-delta"; id: string; delta: string }
  | { type: "assistant-complete"; id: string; text?: string | null }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-complete"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; errorText: string }
  | { type: "error"; errorText: string; detail?: string }
  | { type: "finish"; usage?: AgentTUIStreamUsage };

export type AgentTUITurnState = {
  boundaryEvent?: "session.completed" | "session.failed" | "session.waiting";
  pendingApprovals: AgentTUIToolApprovalRequest[];
  pendingQuestions: InputRequest[];
  sawSessionFailure: boolean;
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
  /** Message-of-the-day line shown under the brand line (local sessions only). */
  tip?: string;
};

export type AgentTUIRenderer = {
  /**
   * Commits a startup header describing the connected agent (brand mark,
   * model, instructions, tools, skills, subagents) to the transcript before
   * the first prompt, and refreshes it after local dev artifact changes.
   * Optional — renderers without a header simply skip it.
   */
  renderAgentHeader?(header: AgentTUIAgentHeader): void;
  /**
   * Commits a single informational line to the transcript. Used for session
   * recovery and slash-command results. Optional.
   */
  renderNotice?(text: string): void;
  /**
   * Commits one development sandbox lifecycle line to the transcript.
   * Optional so non-terminal renderers can ignore local prewarm progress.
   */
  renderSandboxLog?(text: string): void;
  renderSetupWarning?(text: string): void;
  /** Clears the setup attention line once its issue is resolved. */
  clearSetupWarning?(): void;
  /** Commits the startup `/vc:login` invocation to the transcript. */
  renderCommandInvocation?(text: string, status?: "failed"): void;
  renderCommandResult?(text: string): void;
  readonly setupFlow?: SetupFlowRenderer;
  readPrompt?(options?: AgentTUISessionOptions): Promise<string | undefined>;
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
   * Out-of-band update for one child step (reasoning + message text) of a
   * subagent dispatch. Called by the runner as child-session stream events
   * arrive. The renderer renders this as a body section colored by the
   * subagent palette.
   */
  upsertSubagentStep?(update: SubagentStepUpdate): void;
  /**
   * Out-of-band update for one child tool call of a subagent dispatch.
   */
  upsertSubagentTool?(update: SubagentToolUpdate): void;
  /**
   * Registers a tool call id as originating from a subagent's child
   * session. The renderer must skip or remove parent-level tool blocks for
   * these ids — they are surfaced via {@link upsertSubagentTool} instead.
   */
  markChildToolCallId?(callId: string): void;
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
   * status line: linked project identity and the session's pending-deploy
   * flag. Pushed by the runner at startup (async probe) and after
   * /vercel, /channels, /deploy outcomes. Renderers without a status
   * line ignore it.
   */
  setVercelStatus?(status: VercelStatusSnapshot): void;
  /** Sets the remote deployment badge and its current connection/authentication state. */
  setRemoteConnectionStatus?(status: RemoteConnectionSnapshot): void;
  /**
   * Clears the rendered transcript and resets per-conversation display
   * state, leaving the UI interactive on a fresh screen. Used by the
   * `/new` command to start a new session with a clean slate.
   */
  reset?(): void;
  /**
   * Tears down interactive mode and restores the terminal when the runner's
   * lifecycle ends.
   */
  shutdown?(): void;
};

export interface PromptCommandHandlerContext {
  readonly renderer: AgentTUIRenderer;
  readonly title: string;
  /** Provider entry authorized by confirmed boot-time model-access evidence. */
  readonly initialModelStep?: "provider";
  readonly remoteConnection?: RemoteConnectionController;
}

/** What one handled slash command leaves behind for the runner to apply. */
export interface PromptCommandOutcome {
  /** Outcome line rendered under the echoed command; absent renders nothing. */
  message?: string;
  /** Post-command work; model access also re-probes the Vercel identity. */
  effect?: VercelStatusEffect | { kind: "model-access-changed" };
}

export interface PromptCommandHandler {
  handle(
    command: Extract<PromptCommand, { type: "extension" }>,
    context: PromptCommandHandlerContext,
  ): Promise<PromptCommandOutcome | undefined>;
}

export type EveTUIRunnerOptions = TuiDisplayOptions & {
  session: ClientSession;
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
   * active session after HMR so the next prompt uses the latest authored
   * artifacts; input-response resumes keep the current session.
   */
  serverUrl?: string;
  /** Absolute local application root; omitted for remote `--url` sessions. */
  appRoot?: string;
  /**
   * Seeds the editable prompt buffer for the first prompt only. The text is
   * not auto-submitted — the user can edit it and presses Enter to send.
   */
  initialInput?: string;
  /** Handles non-core slash commands without adding feature branches to the runner. */
  promptCommandHandler?: PromptCommandHandler;
  /** Commands shown in discovery for this local or remote session. */
  availablePromptCommands?: readonly PromptCommandSpec[];
  /** Remote target and mutable OIDC token source, when connected through `--url`. */
  remote?: {
    readonly target: RemoteDevelopmentTarget;
    readonly credentials: DevelopmentCredentialGate;
    readonly resolveOidcToken: NonNullable<RemoteConnectionControllerOptions["resolveOidcToken"]>;
    readonly resolveDeployment: NonNullable<RemoteConnectionControllerOptions["resolveDeployment"]>;
  };
  /** Boot-time installation-state checks; defaults to the built-ins. */
  bootDetections?: readonly BootDetection[];
  /** Test seam for the status line's Vercel link probe; defaults to the real one. */
  detectProjectIdentity?: typeof detectProjectIdentity;
  /** Test seam for the off-critical-path boot login probe; defaults to the real one. */
  getVercelAuthStatus?: typeof getVercelAuthStatus;
  /** Reports phases from this runner's initial local-dev connection. */
  onBootProgress?: DevBootProgressReporter;
};

/** The attention-line issue for a Vercel auth state, or undefined when nothing's wrong. */
function authIssueForStatus(status: VercelAuthStatus): SetupIssue | undefined {
  if (status === "logged-out") return LOGIN_SETUP_ISSUE;
  if (status === "cli-missing") return CLI_MISSING_SETUP_ISSUE;
  return undefined;
}

export class EveTUIRunner {
  #session: ClientSession;
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
  readonly #runtimeArtifacts?: DevelopmentRuntimeArtifactSessionRefresher;
  readonly #serverUrl?: string;
  readonly #appRoot?: string;
  /** Seeds the first prompt's editable buffer; consumed once in {@link #run}. */
  readonly #initialInput?: string;
  readonly #promptCommandHandler?: PromptCommandHandler;
  readonly #availablePromptCommands: readonly PromptCommandSpec[];
  readonly #remoteConnection?: RemoteConnectionController;
  readonly #bootDetections: readonly BootDetection[];
  readonly #getVercelAuthStatus: typeof getVercelAuthStatus;
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
  /**
   * The header's message-of-the-day, picked once so dev HMR header
   * refreshes don't re-roll it mid-session. Local sessions only — every
   * tip references local-only slash commands.
   */
  readonly #headerTip = pickAgentHeaderTip();
  #agentInfo?: AgentInfoResult;
  /**
   * approval-id → input-request map populated as `input.requested` events
   * stream in. Used to translate the renderer's approval responses back into
   * eve `InputResponse[]` payloads on the next `send()`.
   */
  readonly #pendingInputRequests = new Map<string, InputRequest>();
  /**
   * callId → live state for one subagent dispatch. Persists across turn
   * boundaries because a subagent dispatched in one turn may not emit
   * `subagent.completed` until a later turn (e.g. after a HITL approval).
   * Each run holds per-step text accumulators (so reasoning + message land
   * in the same section per child step) and per-tool state.
   */
  readonly #subagentRuns = new Map<string, SubagentRun>();
  /**
   * callId → AbortController for the parallel child-session stream pump
   * launched on `subagent.called`. Cancelled on `subagent.completed` or
   * when the runner shuts down.
   */
  readonly #subagentChildPumps = new Map<string, AbortController>();
  /**
   * name → latest known state for one MCP connection
   * authorization lifecycle. Persists across turns because a turn that
   * suspends on a webhook callback resumes in a later turn — the
   * `_required`/`_pending` events fire in turn N and the `_completed`
   * event may not arrive until turn N+1. Each entry holds enough
   * context to re-render the body section idempotently from any
   * single event.
   */
  readonly #connectionAuthRuns = new Map<string, ConnectionAuthRun>();
  /**
   * Set of connection names currently in the `pending` state — i.e.
   * the workflow is suspended waiting on the framework-owned OAuth
   * callback. Used to drive the renderer's bottom-bar hint.
   */
  readonly #pendingConnectionAuths = new Set<string>();
  /**
   * Set when the active server session reaches a terminal failure — either a
   * `session.failed` stream event or a transport error dispatching the turn.
   * The run loop starts a fresh session before the next prompt so the user can
   * keep going instead of typing into a dead session.
   */
  #sessionFailed = false;
  #unsubscribeDevelopmentSandboxLogs?: () => void;

  constructor(options: EveTUIRunnerOptions) {
    this.#session = options.session;
    if (options.client !== undefined) this.#client = options.client;
    this.#renderer = createRenderer(options);
    this.#name = options.name ?? "eve";
    this.#tools = options.tools ?? "full";
    this.#reasoning = options.reasoning ?? "full";
    this.#subagents = options.subagents ?? "full";
    this.#connectionAuth = options.connectionAuth ?? "full";
    this.#assistantResponseStats = options.assistantResponseStats ?? defaultAssistantResponseStats;
    this.#contextSize = options.contextSize;
    this.#formatTransportError = options.formatTransportError ?? toErrorMessage;
    if (options.initialInput !== undefined) this.#initialInput = options.initialInput;
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
    }
    if (options.promptCommandHandler !== undefined) {
      this.#promptCommandHandler = options.promptCommandHandler;
    }
    this.#availablePromptCommands = options.availablePromptCommands ?? PROMPT_COMMANDS;
    if (options.remote !== undefined) {
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
    if (options.onBootProgress !== undefined) this.#onBootProgress = options.onBootProgress;
    if (options.serverUrl !== undefined) this.#serverUrl = options.serverUrl;
    if (options.serverUrl !== undefined && options.remote === undefined) {
      this.#runtimeArtifacts = createDevelopmentRuntimeArtifactSessionRefresher({
        serverUrl: options.serverUrl,
      });
    }
  }

  /**
   * Fetches the agent inspection payload (best-effort) and renders the startup
   * header. Never throws: a missing or unauthorized `/eve/v1/info` simply
   * yields a header without the agent's configuration detail.
   */
  async #renderAgentHeader(): Promise<void> {
    const serverUrl = this.#serverUrl;
    if (serverUrl === undefined) {
      this.#reportBeforeFirstPaint();
      await this.#renderSetupIssues(undefined);
      return;
    }

    let info: AgentInfoResult | undefined;
    if (this.#remoteConnection !== undefined) {
      const connection = await this.#remoteConnection.check();
      if (connection.state === "ready") info = connection.info;
    } else {
      try {
        info = await devBootPhase(
          "connecting to agent",
          () => (this.#client ? this.#client.info() : Promise.resolve(undefined)),
          this.#onBootProgress,
        );
      } catch {
        info = undefined;
      }
    }
    this.#reportBeforeFirstPaint();
    const headerInfo = this.#replaceAgentInfo(info);
    await this.#renderSetupIssues(headerInfo);
  }

  #replaceAgentInfo(info: AgentInfoResult | undefined): AgentInfoResult | undefined {
    const headerInfo =
      this.#appRoot === undefined ? info : resolveModelProviderState(info, process.env);
    this.#agentInfo = headerInfo;
    const serverUrl = this.#serverUrl;
    if (serverUrl === undefined) return headerInfo;

    const header: AgentTUIAgentHeader = {
      name: this.#name,
      serverUrl,
    };
    if (headerInfo !== undefined) header.info = headerInfo;
    if (this.#appRoot !== undefined) header.tip = this.#headerTip;
    this.#renderer.renderAgentHeader?.(header);
    return headerInfo;
  }

  #reportBeforeFirstPaint(): void {
    const report = this.#onBootProgress;
    this.#onBootProgress = undefined;
    report?.({ type: "before-first-paint" });
  }

  async run() {
    try {
      await this.#run();
    } finally {
      this.#disposed = true;
      this.#authProbeAbort.abort();
      // Restore captured stdout/stderr before a fatal error reaches the CLI.
      this.#unsubscribeDevelopmentSandboxLogs?.();
      this.#unsubscribeDevelopmentSandboxLogs = undefined;
      this.#renderer.shutdown?.();
      // Drops any in-flight link probe so a late resolution cannot paint
      // into a torn-down terminal.
      this.#vercelStatus?.dispose();
      this.#remoteConnection?.dispose();
    }
  }

  async #run() {
    const title = this.#name;
    let prompt: string | undefined;
    let automaticSetup: ReturnType<typeof automaticSetupCommand> = undefined;
    let pendingInputResponses: readonly InputResponse[] | undefined;
    let hasRunTurn = false;
    let streamWithoutPrompt = false;
    // `--input` seed: applied to the first prompt's editable buffer, then
    // cleared so later prompts open empty.
    let initialDraft = this.#initialInput;

    await this.#renderAgentHeader();
    if (this.#remoteConnection?.current().connection.state === "auth-required") {
      await this.#executeExtensionCommand(
        { type: "extension", name: "vc:login", argument: "" },
        title,
        "startup",
      );
    }
    this.#subscribeDevelopmentSandboxLogs();
    // Fire-and-forget: the link identity is network-bound to resolve, and the
    // first prompt must not wait on it. The segment appears when it lands.
    this.#vercelStatus?.refreshIdentity();

    if (this.#promptCommandHandler !== undefined && this.#renderer.setupFlow !== undefined) {
      automaticSetup = automaticSetupCommand(this.#bootIssues);
      prompt = automaticSetup?.prompt;
    }

    while (true) {
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
            prompt = await this.#readPromptWithIdleRefresh(promptOptions);
          } catch (error) {
            if (isInterruptedError(error)) {
              return;
            }

            throw error;
          }

          if (prompt == null) {
            return;
          }
        }

        const command = parsePromptCommand(prompt);

        if (command?.type === "exit") {
          return;
        }

        if (command?.type === "new") {
          this.#startNewSession();
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          this.#renderer.reset?.();
          continue;
        }

        // Help renders locally; unlike extension commands it must work even
        // without a prompt-command handler (e.g. remote --url sessions).
        if (command?.type === "help") {
          this.#renderCommandOutcome(formatPromptCommandHelp(this.#availablePromptCommands));
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        // Like /help, /loglevel renders locally: it adjusts the renderer's
        // own log filter, so it works without a prompt-command handler.
        if (command?.type === "loglevel") {
          this.#renderCommandOutcome(this.#applyLogLevelCommand(command.argument));
          pendingInputResponses = undefined;
          streamWithoutPrompt = false;
          prompt = undefined;
          continue;
        }

        if (command?.type === "extension") {
          try {
            const initialModelStep =
              command.name === "model" ? automaticSetup?.initialModelStep : undefined;
            automaticSetup = undefined;
            await this.#executeExtensionCommand(command, title, "command", initialModelStep);
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

      const result = await this.#streamTurn({
        prompt: streamWithoutPrompt ? undefined : prompt,
        inputResponses: pendingInputResponses,
      });

      try {
        await this.#renderer.renderStream(result, {
          title,
          submittedPrompt: prompt,
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
                optionId: response.approved ? "approve" : "deny",
              });
              this.#pendingInputRequests.delete(request.approvalId);
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
              this.#pendingInputRequests.delete(inputRequest.requestId);
            }
          }

          streamWithoutPrompt = true;
          pendingInputResponses = responses;
          prompt = undefined;
          continue;
        }

        if (result.turnState && result.turnState.boundaryEvent === undefined) {
          this.#sessionFailed = true;
        }
      } catch (error) {
        if (isInterruptedError(error)) {
          return;
        }

        throw error;
      }

      streamWithoutPrompt = false;
      pendingInputResponses = undefined;
      prompt = undefined;

      // The active session died terminally this turn (session.failed or a
      // dead-socket transport error). Replace it with a fresh one so the next
      // prompt isn't sent into a dead session, but keep the transcript on
      // screen. Server-side context is gone with the old session.
      if (this.#sessionFailed) {
        this.#sessionFailed = false;
        this.#startNewSession();
        this.#renderer.renderNotice?.(
          "Session ended — started a new session. Earlier context was cleared.",
        );
      }
    }
  }

  /**
   * Resets all per-conversation runner state and, when a client is
   * available, replaces the active session with a fresh one so the next
   * turn starts a new server-side conversation. Backs the `/new` command.
   * In-flight subagent child-session streams are aborted.
   */
  #startNewSession(): void {
    for (const controller of this.#subagentChildPumps.values()) {
      controller.abort();
    }
    this.#subagentChildPumps.clear();
    this.#subagentRuns.clear();
    this.#pendingInputRequests.clear();
    this.#connectionAuthRuns.clear();
    this.#pendingConnectionAuths.clear();

    if (this.#client) {
      this.#session = this.#client.session();
    }
    this.#runtimeArtifacts?.clear();
  }

  async #readPromptWithIdleRefresh(options: AgentTUISessionOptions): Promise<string | undefined> {
    if (!this.#renderer.readPrompt) {
      return undefined;
    }

    const prompt = this.#renderer.readPrompt(options);
    const client = this.#client;
    const runtimeArtifacts = this.#runtimeArtifacts;
    if (client === undefined || runtimeArtifacts === undefined) {
      return await prompt;
    }

    let stopped = false;
    let refreshing = false;
    let inFlightRefresh: Promise<void> | undefined;
    const refresh = async () => {
      if (stopped || refreshing) {
        return;
      }

      refreshing = true;
      try {
        this.#session = await runtimeArtifacts.refreshIdle({
          createSession: () => client.session(),
          onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
          session: this.#session,
        });
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

  async #streamTurn(input: {
    prompt: string | undefined;
    inputResponses: readonly InputResponse[] | undefined;
  }): Promise<AgentTUIStreamResult> {
    // Backs the result's `abort`: the renderer fires it on Ctrl+C so the
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
    try {
      const client = this.#client;
      if (client !== undefined && this.#runtimeArtifacts !== undefined) {
        this.#session = await this.#runtimeArtifacts.refresh({
          createSession: () => client.session(),
          inputResponses: sendInput.inputResponses,
          message: sendInput.message,
          onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
          session: this.#session,
        });
      }

      if (sendInput.message !== undefined && (sendInput.inputResponses?.length ?? 0) === 0) {
        this.#renderer.flushDelayedDevBuildErrors?.();
      }

      response = await this.#session.send(sendInput);
    } catch (error) {
      if (isInterruptedError(error)) throw error;
      // Dispatching the turn failed before any stream opened (transport
      // error, auth challenge, …). Surface it through the same error path
      // as in-stream failures so it renders as an inline region right
      // where the assistant response would have appeared, then let the
      // loop recover onto a fresh session before the next prompt.
      this.#remoteConnection?.reportFailure(error);
      this.#sessionFailed = true;
      return {
        events: errorOnlyTUIStream({
          errorText: this.#formatTransportError(error),
        }),
        turnState: createTurnState(),
      };
    }

    const turnState = createTurnState();

    return {
      abort: () => abortController.abort(),
      events: eveEventsToTUIStream({
        events: response,
        pendingInputRequests: this.#pendingInputRequests,
        subagentRuns: this.#subagentRuns,
        turnState,
        onSubagentCalled: (called) => this.#startSubagentChildPump(called),
        onSubagentCompleted: (callId) => this.#stopSubagentChildPump(callId),
        onConnectionAuthRequired: (event) => this.#handleConnectionAuthRequired(event),
        onConnectionAuthCompleted: (event) => this.#handleConnectionAuthCompleted(event),
        onTerminalFailure: () => {
          this.#sessionFailed = true;
        },
        failureOverride:
          this.#appRoot === undefined
            ? undefined
            : (event) =>
                isGatewayAuthFailure(event) ? formatGatewayAuthFailureNotice(event) : undefined,
      }),
      turnState,
    };
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
    if (appRoot === undefined) return;
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
   * so a fixed issue clears (e.g. the `not logged in · /vc:login` line disappears
   * once `/vc:login` succeeds) instead of lingering stale. Authoritative: unlike
   * the boot probe it re-reads detections and auth and is not stale-guarded.
   */
  async #refreshSetupAttention(info: AgentInfoResult | undefined): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) return;
    if (this.#renderer.renderSetupWarning === undefined) return;
    const context: BootDetectionContext = { appRoot, env: process.env };
    if (info !== undefined) context.info = info;
    try {
      this.#bootIssues = await detectSetupIssues(context, this.#bootDetections);
      const status = await this.#getVercelAuthStatus(appRoot, {
        signal: this.#authProbeAbort.signal,
      });
      this.#authIssue = authIssueForStatus(status);
    } catch {
      return;
    }
    if (this.#disposed) return;
    this.#paintSetupAttention();
  }

  #subscribeDevelopmentSandboxLogs(): void {
    if (this.#appRoot === undefined || this.#renderer.renderSandboxLog === undefined) {
      return;
    }
    if (this.#unsubscribeDevelopmentSandboxLogs !== undefined) {
      return;
    }

    this.#unsubscribeDevelopmentSandboxLogs = subscribeDevelopmentSandboxPrewarmLogs({
      appRoot: this.#appRoot,
      log: (message) => this.#renderer.renderSandboxLog?.(message),
    });
  }

  #renderCommandOutcome(text: string | undefined): void {
    if (text === undefined) return;
    if (this.#renderer.renderCommandResult !== undefined) {
      this.#renderer.renderCommandResult(text);
      return;
    }
    this.#renderer.renderNotice?.(text);
  }

  async #handleExtensionCommand(
    command: Extract<PromptCommand, { type: "extension" }>,
    input: Pick<PromptCommandHandlerContext, "initialModelStep" | "title">,
  ): Promise<PromptCommandOutcome | undefined> {
    const handler = this.#promptCommandHandler;
    if (handler === undefined)
      return { message: `/${command.name} is not available in this session.` };

    return await handler.handle(command, {
      renderer: this.#renderer,
      title: input.title,
      initialModelStep: input.initialModelStep,
      remoteConnection: this.#remoteConnection,
    });
  }

  #renderStartupCommandInvocation(
    command: Extract<PromptCommand, { type: "extension" }>,
    trigger: "startup" | "command",
  ): void {
    if (trigger !== "startup") return;

    const state = this.#remoteConnection?.current().connection.state;
    const status = state === "auth-failed" || state === "unavailable" ? "failed" : undefined;
    const argument = command.argument.length === 0 ? "" : ` ${command.argument}`;
    this.#renderer.renderCommandInvocation?.(`/${command.name}${argument}`, status);
  }

  async #applyCommandEffect(effect: PromptCommandOutcome["effect"]): Promise<void> {
    if (effect?.kind === "model-access-changed") {
      this.#vercelStatus?.applyEffect({ kind: "refresh-identity" });
      this.#authHintStale = true;
      await this.#refreshModelAccess();
      return;
    }
    if (effect === undefined) return;

    this.#vercelStatus?.applyEffect(effect);
    this.#authHintStale = true;
    void this.#refreshSetupAttention(this.#agentInfo);
  }

  async #executeExtensionCommand(
    command: Extract<PromptCommand, { type: "extension" }>,
    title: string,
    trigger: "startup" | "command",
    initialModelStep?: "provider",
  ): Promise<void> {
    const outcome = await this.#handleExtensionCommand(command, { initialModelStep, title });
    this.#renderStartupCommandInvocation(command, trigger);
    this.#renderCommandOutcome(outcome?.message);
    await this.#applyCommandEffect(outcome?.effect);
    this.#refreshHeaderFromRemoteConnection();
  }

  #refreshHeaderFromRemoteConnection(): void {
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

  /**
   * Setup commands can write env files before the dev watcher reloads them.
   * Reload first, then cache the credential-normalized `/info` snapshot shared
   * by the status bar and setup detector. The Vercel auth probe stays off the
   * prompt path.
   */
  async #refreshModelAccess(): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) return;

    loadDevelopmentEnvironmentFiles(appRoot);
    const refreshedInfo = this.#replaceAgentInfo(await this.#readAgentInfo());
    void this.#refreshSetupAttention(refreshedInfo);
  }

  async #readAgentInfo(): Promise<AgentInfoResult | undefined> {
    try {
      return await this.#client?.info();
    } catch {
      return undefined;
    }
  }

  async #handleRuntimeArtifactsChanged(): Promise<void> {
    const previousInfo = this.#agentInfo;
    const nextInfo = await this.#readAgentInfo();
    if (nextInfo !== undefined) this.#replaceAgentInfo(nextInfo);

    if (!this.#renderer.renderAgentHeader || nextInfo === undefined) {
      this.#renderer.renderNotice?.(formatAgentUpdateNotice(previousInfo, nextInfo));
    }
  }

  #handleConnectionAuthRequired(event: AuthorizationRequiredStreamEvent): void {
    const run: ConnectionAuthRun = {
      name: event.data.name,
      description: event.data.description,
      state: "required",
    };
    if (event.data.authorization !== undefined) {
      run.challenge = event.data.authorization;
    }
    if (event.data.webhookUrl !== undefined) {
      run.webhookUrl = event.data.webhookUrl;
    }
    this.#connectionAuthRuns.set(event.data.name, run);
    this.#emitConnectionAuthUpdate(run);
  }

  #handleConnectionAuthCompleted(event: AuthorizationCompletedStreamEvent): void {
    const existing = this.#connectionAuthRuns.get(event.data.name);
    const run: ConnectionAuthRun = existing ?? {
      name: event.data.name,
      description: "",
      state: event.data.outcome,
    };
    run.state = event.data.outcome;
    if (event.data.reason !== undefined) {
      run.reason = event.data.reason;
    }
    this.#connectionAuthRuns.set(event.data.name, run);
    this.#pendingConnectionAuths.delete(event.data.name);
    this.#emitConnectionAuthUpdate(run);
    this.#renderer.setConnectionAuthPendingCount?.(this.#pendingConnectionAuths.size);
  }

  #emitConnectionAuthUpdate(run: ConnectionAuthRun): void {
    const update: ConnectionAuthUpdate = {
      name: run.name,
      description: run.description,
      state: run.state,
    };
    if (run.challenge !== undefined) update.challenge = run.challenge;
    if (run.reason !== undefined) update.reason = run.reason;
    this.#renderer.upsertConnectionAuth?.(update);
  }

  /**
   * Opens a parallel stream over the child session and folds its events into
   * nested subagent blocks.
   *
   * Pumps are fire-and-forget and must never be awaited at a turn boundary:
   * a subagent dispatched in `task` mode that parks for HITL never emits a
   * turn-boundary event on its own stream (`harness/tool-loop.ts` gates
   * `emitTurnEpilogue` on `mode === "conversation"`), so blocking on a child
   * stream would stall the prompt until the subagent's serverless function
   * times out. Pumps stay open across HITL prompts and resume rendering when
   * the subagent unparks; they end on the child's own boundary or via abort.
   */
  #startSubagentChildPump(called: SubagentCalledStreamEvent) {
    const callId = called.data.callId;
    if (this.#subagentChildPumps.has(callId)) return;
    const client = this.#client;
    if (!client) return;

    const controller = new AbortController();
    this.#subagentChildPumps.set(callId, controller);

    void (async () => {
      try {
        const childSession = client.session({
          sessionId: called.data.childSessionId,
          streamIndex: 0,
        });
        const stream = childSession.stream({ signal: controller.signal });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          this.#applyChildEvent(callId, event);
          if (isCurrentTurnBoundaryEvent(event)) {
            // Child completed its turn — close the parallel stream
            // gracefully. The parent's `subagent.completed` is a separate
            // signal that arrives independently and is handled by
            // `#stopSubagentChildPump`.
            break;
          }
        }
      } catch (error) {
        if (!isAbortLikeError(error)) {
          const errorText = toErrorMessage(error);
          const run = this.#subagentRuns.get(callId);
          if (run) {
            const { key, step } = openCurrentSubagentSection(run);
            step.message = step.message
              ? `${step.message}\n\nstream error: ${errorText}`
              : `stream error: ${errorText}`;
            step.finalized = true;
            run.currentSectionKey = null;
            this.#renderer.upsertSubagentStep?.({
              callId,
              subagentName: run.name,
              sectionKey: key,
              reasoning: step.reasoning,
              message: step.message,
              finalized: true,
            });
          }
        }
      } finally {
        this.#subagentChildPumps.delete(callId);
      }
    })();
  }

  #registerChildTool(
    callId: string,
    run: SubagentRun,
    request: {
      childCallId: string;
      toolName: string;
      input: unknown;
      status: SubagentToolState["status"];
    },
  ): void {
    const existing = run.tools.get(request.childCallId);
    const tool: SubagentToolState = existing ?? {
      toolName: request.toolName,
      input: request.input,
      status: request.status,
    };
    if (existing) {
      // Promote status only when the new status is "stronger" — e.g.
      // approval-requested → executing once the parent approves, but
      // never demote from done/failed back to executing.
      const priority: Record<SubagentToolState["status"], number> = {
        "approval-requested": 0,
        executing: 1,
        done: 2,
        failed: 2,
      };
      if (priority[request.status] > priority[existing.status]) {
        existing.status = request.status;
      }
      existing.input = request.input;
    } else {
      run.tools.set(request.childCallId, tool);
    }
    this.#renderer.markChildToolCallId?.(request.childCallId);
    this.#renderer.upsertSubagentTool?.({
      callId,
      subagentName: run.name,
      childCallId: request.childCallId,
      toolName: tool.toolName,
      input: tool.input,
      status: tool.status,
    });
  }

  #stopSubagentChildPump(callId: string) {
    // Parent reports subagent.completed. The child stream pump terminates
    // itself on the child's own turn boundary; we do NOT abort here,
    // because the child's `message.completed` event may still be in flight
    // (the parent and child streams are independent HTTP connections).
    // Re-emit a finalized snapshot for any sections that are still
    // streaming so their right-title flips off `streaming` even if the
    // child's boundary event hasn't arrived yet.
    const run = this.#subagentRuns.get(callId);
    if (!run) return;
    for (const [sectionKey, step] of run.steps) {
      if (!step.finalized) {
        step.finalized = true;
        this.#renderer.upsertSubagentStep?.({
          callId,
          subagentName: run.name,
          sectionKey,
          reasoning: step.reasoning,
          message: step.message,
          finalized: true,
        });
      }
    }
    run.currentSectionKey = null;
  }

  #applyChildEvent(callId: string, event: HandleMessageStreamEvent) {
    const run = this.#subagentRuns.get(callId);
    if (!run) return;
    const renderer = this.#renderer;

    const emit = (key: number, step: SubagentChildStep) => {
      renderer.upsertSubagentStep?.({
        callId,
        subagentName: run.name,
        sectionKey: key,
        reasoning: step.reasoning,
        message: step.message,
        finalized: step.finalized,
      });
    };

    const finalizeCurrent = () => {
      if (run.currentSectionKey === null) return;
      const step = run.steps.get(run.currentSectionKey);
      if (step) {
        step.finalized = true;
        emit(run.currentSectionKey, step);
      }
      run.currentSectionKey = null;
    };

    switch (event.type) {
      case "reasoning.appended": {
        const { key, step } = openCurrentSubagentSection(run);
        step.reasoning = step.reasoning + event.data.reasoningDelta;
        emit(key, step);
        break;
      }
      case "reasoning.completed":
        // Reasoning closes within a section but does not close the section
        // itself — a following `message.appended` should land in the same
        // box. The section closes on `message.completed` or
        // `step.completed`.
        break;
      case "message.appended": {
        const { key, step } = openCurrentSubagentSection(run);
        step.message = step.message + event.data.messageDelta;
        emit(key, step);
        break;
      }
      case "message.completed": {
        const { key, step } = openCurrentSubagentSection(run);
        if (event.data.message !== null && step.message.length === 0) {
          // Some channels emit only `message.completed` without per-delta
          // `message.appended` events. Capture the full text in that case.
          step.message = event.data.message;
        }
        step.finalized = true;
        emit(key, step);
        run.currentSectionKey = null;
        break;
      }
      case "step.completed":
        finalizeCurrent();
        break;
      case "actions.requested": {
        // Close any pending text section before the tool call so the
        // tool box renders below it — and the next post-tool message
        // opens a fresh section.
        finalizeCurrent();
        for (const action of event.data.actions) {
          if (action.kind !== "tool-call") continue;
          this.#registerChildTool(callId, run, {
            childCallId: action.callId,
            toolName: action.toolName,
            input: action.input,
            status: "executing",
          });
        }
        break;
      }
      case "input.requested": {
        // Tools that need approval skip `actions.requested` and arrive
        // here as `input.requested` with the action embedded. Register
        // the tool section the same way (status: "approval-requested")
        // so the parent's stale tool box can be suppressed and the
        // child tool appears under the subagent flow.
        finalizeCurrent();
        for (const request of event.data.requests) {
          if (request.action.kind !== "tool-call") continue;
          this.#registerChildTool(callId, run, {
            childCallId: request.action.callId,
            toolName: request.action.toolName,
            input: request.action.input,
            status: "approval-requested",
          });
        }
        break;
      }
      case "action.result": {
        const result = event.data.result;
        if (result.kind !== "tool-result") break;
        const tool = run.tools.get(result.callId);
        if (!tool) break;
        if (event.data.status === "failed") {
          tool.status = "failed";
          tool.errorText = formatActionResultError(event);
        } else {
          tool.status = "done";
          tool.output = result.output;
        }
        const update: SubagentToolUpdate = {
          callId,
          subagentName: run.name,
          childCallId: result.callId,
          toolName: tool.toolName,
          input: tool.input,
          status: tool.status,
        };
        if (tool.output !== undefined) update.output = tool.output;
        if (tool.errorText !== undefined) update.errorText = tool.errorText;
        renderer.upsertSubagentTool?.(update);
        break;
      }
      default:
        // Other events (session.*, turn.*, step.started, etc.) carry no
        // visible text — ignore.
        break;
    }
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
    input: options.userInput,
    output: options.screen,
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
  events: AsyncIterable<HandleMessageStreamEvent>;
  pendingInputRequests: Map<string, InputRequest>;
  subagentRuns: Map<string, SubagentRun>;
  turnState: AgentTUITurnState;
  onSubagentCalled?: (event: SubagentCalledStreamEvent) => void;
  onSubagentCompleted?: (callId: string) => void;
  onConnectionAuthRequired?: (event: AuthorizationRequiredStreamEvent) => void;
  onConnectionAuthCompleted?: (event: AuthorizationCompletedStreamEvent) => void;
  onTerminalFailure?: (event: SessionFailedStreamEvent) => void;
  failureOverride?: (event: FailureStreamEvent) => string | undefined;
};

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
    pendingInputRequests,
    subagentRuns,
    turnState,
    onSubagentCalled,
    onSubagentCompleted,
    onConnectionAuthRequired,
    onConnectionAuthCompleted,
    onTerminalFailure,
    failureOverride,
  } = input;
  const textParts = new Map<string, StreamPartState>();
  const reasoningParts = new Map<string, StreamPartState>();
  // Counts `step.started` events. The harness reuses `stepIndex` across the
  // model calls of one turn (e.g. the post-subagent call restarts at the same
  // index), so a part key alone cannot distinguish "new message under a
  // reused key" from "replayed events of the finished message". A fresh
  // `step.started` since the part completed is the discriminator.
  let stepEpoch = 0;
  const knownToolCalls = new Set<string>();
  const ignoredToolCallIds = new Set<string>();
  const seenToolBatches = new Set<string>();
  // The harness reports one underlying failure as a cascade (`step.failed` →
  // `turn.failed` → `session.failed`) with an identical payload on each
  // event. Render it once, not three times.
  const emittedFailures = new Set<string>();
  let sentFinish = false;
  let visibleTurnCompleted = false;
  let latestStepUsage: StepCompletedStreamEvent["data"]["usage"] | undefined;

  for await (const event of events) {
    if (visibleTurnCompleted && isPostTurnVisibleEvent(event)) {
      continue;
    }

    switch (event.type) {
      case "session.started":
      case "turn.started":
      case "message.received":
        // Boundary / metadata events with no direct UI surface.
        break;

      case "step.started":
        stepEpoch += 1;
        yield { type: "step-start" };
        break;

      case "step.completed": {
        const stepEvent = event as StepCompletedStreamEvent;
        latestStepUsage = stepEvent.data.usage;
        yield* closeOpenParts(textParts, "assistant-complete", stepEpoch);
        yield* closeOpenParts(reasoningParts, "reasoning-complete", stepEpoch);
        yield { type: "step-finish", usage: stepEvent.data.usage };
        break;
      }

      case "message.appended": {
        const appended = event as MessageAppendedStreamEvent;
        const base = textPartId(appended.data.turnId, appended.data.stepIndex);
        const state = partStateFor(textParts, base);
        const next = appended.data.messageSoFar;

        if (state.completed) {
          // Replays of the finished message re-stream prefixes of it — drop.
          if (state.text.startsWith(next)) break;
          // Divergent text without an intervening `step.started` is a retry
          // of the same model call — drop it rather than mixing attempts.
          if (stepEpoch <= state.completedEpoch) break;
          // A fresh model call reusing this part key (the harness restarts
          // `stepIndex` after a park/resume, e.g. post-subagent): open a new
          // message generation so it renders as its own block.
          state.generation += 1;
          state.text = "";
          state.completed = false;
        }

        if (!next.startsWith(state.text) || next.length <= state.text.length) {
          break;
        }

        const delta = next.slice(state.text.length);
        state.text = next;
        yield { type: "assistant-delta", id: partGenerationId(base, state.generation), delta };
        break;
      }

      case "message.completed": {
        const base = textPartId(event.data.turnId, event.data.stepIndex);
        const state = partStateFor(textParts, base);
        const message = event.data.message;

        if (state.completed) {
          if (message === null || message === state.text) break;
          if (stepEpoch <= state.completedEpoch) break;
          // Channels that skip per-delta events: a new full message under a
          // reused key after a fresh model call.
          state.generation += 1;
          state.text = message;
          state.completedEpoch = stepEpoch;
          yield {
            type: "assistant-complete",
            id: partGenerationId(base, state.generation),
            text: message,
          };
          break;
        }

        const id = partGenerationId(base, state.generation);
        if (message !== null) {
          if (state.text.length === 0) {
            state.text = message;
            state.completed = true;
            state.completedEpoch = stepEpoch;
            yield { type: "assistant-complete", id, text: message };
          } else if (message.startsWith(state.text)) {
            const suffix = message.slice(state.text.length);
            if (suffix.length > 0) {
              yield { type: "assistant-delta", id, delta: suffix };
            }
            state.text = message;
            state.completed = true;
            state.completedEpoch = stepEpoch;
            yield { type: "assistant-complete", id };
          }
        } else if (state.text.length > 0) {
          state.completed = true;
          state.completedEpoch = stepEpoch;
          yield { type: "assistant-complete", id };
        }
        break;
      }

      case "reasoning.appended": {
        const appended = event as ReasoningAppendedStreamEvent;
        const base = reasoningPartId(appended.data.turnId, appended.data.stepIndex);
        const state = partStateFor(reasoningParts, base);
        const next = appended.data.reasoningSoFar;

        if (state.completed) {
          if (state.text.startsWith(next)) break;
          if (stepEpoch <= state.completedEpoch) break;
          state.generation += 1;
          state.text = "";
          state.completed = false;
        }

        if (!next.startsWith(state.text) || next.length <= state.text.length) {
          break;
        }

        const delta = next.slice(state.text.length);
        state.text = next;
        yield { type: "reasoning-delta", id: partGenerationId(base, state.generation), delta };
        break;
      }

      case "reasoning.completed": {
        const base = reasoningPartId(event.data.turnId, event.data.stepIndex);
        const state = partStateFor(reasoningParts, base);
        const next = event.data.reasoning;

        if (state.completed) {
          if (next.length === 0 || next === state.text || state.text.startsWith(next)) break;
          if (stepEpoch <= state.completedEpoch) break;
          state.generation += 1;
          state.text = next;
          state.completedEpoch = stepEpoch;
          const id = partGenerationId(base, state.generation);
          yield { type: "reasoning-delta", id, delta: next };
          yield { type: "reasoning-complete", id };
          break;
        }

        const id = partGenerationId(base, state.generation);
        if (state.text.length === 0 && next.length > 0) {
          state.text = next;
          yield { type: "reasoning-delta", id, delta: next };
        } else if (next.length > 0 && !next.startsWith(state.text)) {
          break;
        }

        state.completed = true;
        state.completedEpoch = stepEpoch;
        yield { type: "reasoning-complete", id };
        break;
      }

      case "actions.requested": {
        const data = (event as ActionsRequestedStreamEvent).data;
        const actions = data.actions.filter((action) => action.kind === "tool-call");
        if (actions.length === 0) break;

        const batchKey = toolBatchKey("actions.requested", data.turnId, data.stepIndex, actions);
        if (seenToolBatches.has(batchKey)) {
          for (const action of actions) {
            if (!knownToolCalls.has(action.callId)) {
              ignoredToolCallIds.add(action.callId);
            }
          }
          break;
        }
        seenToolBatches.add(batchKey);

        for (const action of actions) {
          if (knownToolCalls.has(action.callId)) continue;
          knownToolCalls.add(action.callId);
          yield {
            type: "tool-call",
            toolCallId: action.callId,
            toolName: action.toolName,
            input: action.input,
          };
        }
        break;
      }

      case "input.requested": {
        const data = (event as InputRequestedStreamEvent).data;
        const requests = data.requests.filter((request) => request.action.kind === "tool-call");
        if (requests.length === 0) break;

        const batchKey = inputRequestBatchKey(data.turnId, data.stepIndex, requests);
        if (seenToolBatches.has(batchKey)) {
          for (const request of requests) {
            if (!knownToolCalls.has(request.action.callId)) {
              ignoredToolCallIds.add(request.action.callId);
            }
          }
          break;
        }
        seenToolBatches.add(batchKey);

        for (const request of requests) {
          const toolCallId = request.action.callId;

          if (!knownToolCalls.has(toolCallId)) {
            knownToolCalls.add(toolCallId);
            yield {
              type: "tool-call",
              toolCallId,
              toolName: request.action.toolName,
              input: request.action.input,
            };
          }

          pendingInputRequests.set(request.requestId, request);

          if (isQuestionRequest(request)) {
            upsertPendingQuestion(turnState, request);
            continue;
          }

          upsertPendingApproval(turnState, request);
          yield {
            type: "tool-approval-request",
            approvalId: request.requestId,
            toolCallId,
          };
        }
        break;
      }

      case "action.result": {
        const resultEvent = event as ActionResultStreamEvent;
        if (resultEvent.data.result.kind !== "tool-result") {
          break;
        }
        const callId = resultEvent.data.result.callId;
        if (ignoredToolCallIds.has(callId)) break;
        if (!knownToolCalls.has(callId)) {
          // Results for calls this turn never announced (e.g. subagent
          // dispatches, which surface through the subagent section instead)
          // have no tool block to attach to.
          break;
        }
        if (resultEvent.data.status === "failed") {
          yield {
            type: "tool-error",
            toolCallId: callId,
            errorText: formatActionResultError(resultEvent),
          };
        } else {
          yield {
            type: "tool-result",
            toolCallId: callId,
            output: resultEvent.data.result.output,
          };
        }
        break;
      }

      case "step.failed":
      case "turn.failed": {
        const failure = toFailureEvent(event, emittedFailures, failureOverride);
        if (failure) yield failure;
        break;
      }

      case "session.failed": {
        // Terminal: the server session is dead. Flag the runner so it can
        // recover onto a fresh session before the next prompt.
        turnState.sawSessionFailure = true;
        onTerminalFailure?.(event as SessionFailedStreamEvent);
        const failure = toFailureEvent(event, emittedFailures, failureOverride);
        if (failure) yield failure;
        turnState.boundaryEvent = event.type;
        yield* closeOpenParts(textParts, "assistant-complete", stepEpoch);
        yield* closeOpenParts(reasoningParts, "reasoning-complete", stepEpoch);
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
        yield* closeOpenParts(textParts, "assistant-complete", stepEpoch);
        yield* closeOpenParts(reasoningParts, "reasoning-complete", stepEpoch);
        yield {
          type: "finish",
          usage: latestStepUsage,
        };
        sentFinish = true;
        return;

      case "turn.completed":
        visibleTurnCompleted = true;
        yield* closeOpenParts(textParts, "assistant-complete", stepEpoch);
        yield* closeOpenParts(reasoningParts, "reasoning-complete", stepEpoch);
        break;

      case "subagent.called": {
        const called = event as SubagentCalledStreamEvent;
        if (!subagentRuns.has(called.data.callId)) {
          subagentRuns.set(called.data.callId, {
            name: called.data.name,
            steps: new Map(),
            currentSectionKey: null,
            nextSectionKey: 0,
            tools: new Map(),
          });
        } else {
          // Idempotent re-entry (e.g. SSE resume): just refresh the name.
          const run = subagentRuns.get(called.data.callId);
          if (run) run.name = called.data.name;
        }
        onSubagentCalled?.(called);
        break;
      }

      case "subagent.started":
      case "subagent.event":
        // `subagent.started` and `subagent.event` are not emitted by the
        // current harness — the parent stream only sees `called` and
        // `completed`. All intermediate child content is observed via
        // the runner's parallel child-session stream pump.
        break;

      case "subagent.completed": {
        const completed = event as SubagentCompletedStreamEvent;
        onSubagentCompleted?.(completed.data.callId);
        break;
      }

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
    yield* closeOpenParts(textParts, "assistant-complete", stepEpoch);
    yield* closeOpenParts(reasoningParts, "reasoning-complete", stepEpoch);
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
    pendingApprovals: [],
    pendingQuestions: [],
    sawSessionFailure: false,
  };
}

function upsertPendingApproval(state: AgentTUITurnState, request: InputRequest): void {
  const approval = toAgentTUIToolApprovalRequest(request);
  const index = state.pendingApprovals.findIndex(
    (candidate) => candidate.approvalId === approval.approvalId,
  );
  if (index === -1) {
    state.pendingApprovals.push(approval);
  } else {
    state.pendingApprovals[index] = approval;
  }
}

function toAgentTUIToolApprovalRequest(request: InputRequest): AgentTUIToolApprovalRequest {
  return {
    approvalId: request.requestId,
    toolCallId: request.action.callId,
    toolName: request.action.toolName,
    input: request.action.input,
  };
}

function upsertPendingQuestion(state: AgentTUITurnState, request: InputRequest): void {
  const index = state.pendingQuestions.findIndex(
    (candidate) => candidate.requestId === request.requestId,
  );
  if (index === -1) {
    state.pendingQuestions.push(request);
  } else {
    state.pendingQuestions[index] = request;
  }
}

function textPartId(turnId: string, stepIndex: number): string {
  return `text:${turnId}:${stepIndex}`;
}

function reasoningPartId(turnId: string, stepIndex: number): string {
  return `reasoning:${turnId}:${stepIndex}`;
}

/**
 * Per-part-key accumulation state for one assistant text or reasoning trace.
 *
 * eve names parts by `turnId:stepIndex`, but the harness reuses `stepIndex`
 * across the model calls of one turn (the post-park call restarts at the same
 * index). `generation` disambiguates: each fresh model call that reuses a
 * completed key opens generation N+1, which renders as its own block.
 */
type StreamPartState = {
  generation: number;
  /** Accumulated text of the current generation. */
  text: string;
  completed: boolean;
  /** Value of the step epoch when the current generation completed. */
  completedEpoch: number;
};

function partStateFor(parts: Map<string, StreamPartState>, base: string): StreamPartState {
  let state = parts.get(base);
  if (state === undefined) {
    state = { generation: 0, text: "", completed: false, completedEpoch: 0 };
    parts.set(base, state);
  }
  return state;
}

/** Generation 0 keeps the bare key so block ids stay stable for the common case. */
function partGenerationId(base: string, generation: number): string {
  return generation === 0 ? base : `${base}#${generation}`;
}

/** Closes every still-open generation at a step or turn boundary. */
function* closeOpenParts(
  parts: Map<string, StreamPartState>,
  type: "assistant-complete" | "reasoning-complete",
  stepEpoch: number,
): Generator<AgentTUIStreamEvent> {
  for (const [base, state] of parts) {
    if (state.completed || state.text.length === 0) continue;
    state.completed = true;
    state.completedEpoch = stepEpoch;
    yield { type, id: partGenerationId(base, state.generation) };
  }
}

function isPostTurnVisibleEvent(event: HandleMessageStreamEvent): boolean {
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

function toolBatchKey(
  type: string,
  turnId: string,
  stepIndex: number,
  actions: readonly { input: unknown; toolName: string }[],
): string {
  return `${type}:${turnId}:${String(stepIndex)}:${stableStringify(
    actions.map((action) => ({
      input: action.input,
      toolName: action.toolName,
    })),
  )}`;
}

function inputRequestBatchKey(
  turnId: string,
  stepIndex: number,
  requests: readonly InputRequest[],
): string {
  return toolBatchKey(
    "input.requested",
    turnId,
    stepIndex,
    requests.map((request) => ({
      input: request.action.input,
      toolName: request.action.toolName,
    })),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value)) ?? "undefined";
}

function toStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => toStableJson(item, seen));
  }

  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    result[key] = toStableJson(object[key], seen);
  }
  return result;
}

function formatActionResultError(event: ActionResultStreamEvent): string {
  if (event.data.error?.message) return event.data.error.message;
  const output = event.data.result.output;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return "Tool execution failed.";
  }
}

/**
 * Projects one failure event into a renderable `error` stream event, or
 * `undefined` when the same underlying failure was already emitted earlier in
 * the cascade. Attaches the diagnostic dump (stack trace) when the failure
 * carries one — i.e. for unrecognized errors escaping user code.
 */
function toFailureEvent(
  event: FailureStreamEvent,
  emittedFailures: Set<string>,
  failureOverride?: (event: FailureStreamEvent) => string | undefined,
): AgentTUIStreamEvent | undefined {
  const key = failureKey(event);
  if (emittedFailures.has(key)) return undefined;
  emittedFailures.add(key);

  const override = failureOverride?.(event);
  const failure: AgentTUIStreamEvent = {
    type: "error",
    errorText: override ?? formatFailureMessage(event),
  };
  if (override !== undefined) return failure;
  const detail = formatFailureDetail(event);
  if (detail !== undefined) failure.detail = detail;
  return failure;
}

function isQuestionRequest(request: InputRequest): boolean {
  if (request.display === "select" || request.display === "text") return true;
  if (request.display === "confirmation") return false;
  return request.options !== undefined && request.options.length > 0;
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

type SubagentChildStep = {
  reasoning: string;
  message: string;
  finalized: boolean;
};

type SubagentToolState = {
  toolName: string;
  input: unknown;
  status: "approval-requested" | "executing" | "done" | "failed";
  output?: unknown;
  errorText?: string;
};

export type SubagentRun = {
  name: string;
  /**
   * One entry per logical "child message" — independent of the child's
   * `stepIndex` field, which the harness can reuse across multiple
   * assistant messages within a turn (e.g. a message before a tool call
   * and another message after the tool result both arrive under
   * `stepIndex: 0`). The key is a monotonic counter so each
   * `message.completed` opens a new box on the next inbound delta.
   */
  steps: Map<number, SubagentChildStep>;
  /**
   * Section currently accepting reasoning/message deltas. `null` means
   * the next delta opens a new section.
   */
  currentSectionKey: number | null;
  /** Monotonic counter for new section keys. */
  nextSectionKey: number;
  tools: Map<string, SubagentToolState>;
};

export type SubagentStepUpdate = {
  callId: string;
  subagentName: string;
  sectionKey: number;
  reasoning: string;
  message: string;
  finalized: boolean;
};

export type SubagentToolUpdate = {
  callId: string;
  subagentName: string;
  childCallId: string;
  toolName: string;
  input: unknown;
  status: "approval-requested" | "executing" | "done" | "failed";
  output?: unknown;
  errorText?: string;
};

export type ConnectionAuthChallenge = {
  url?: string;
  userCode?: string;
  expiresAt?: string;
  instructions?: string;
};

export type ConnectionAuthState = "required" | "pending" | ConnectionAuthorizationOutcome;

export type ConnectionAuthUpdate = {
  name: string;
  description: string;
  state: ConnectionAuthState;
  challenge?: ConnectionAuthChallenge;
  reason?: string;
};

type ConnectionAuthRun = {
  name: string;
  description: string;
  state: ConnectionAuthState;
  challenge?: ConnectionAuthChallenge;
  webhookUrl?: string;
  reason?: string;
};

function openCurrentSubagentSection(run: SubagentRun): {
  key: number;
  step: SubagentChildStep;
} {
  if (run.currentSectionKey === null) {
    run.currentSectionKey = run.nextSectionKey++;
    run.steps.set(run.currentSectionKey, { reasoning: "", message: "", finalized: false });
  }
  const step = run.steps.get(run.currentSectionKey);
  if (!step) {
    throw new Error("invariant: subagent section state missing for current key");
  }
  return { key: run.currentSectionKey, step };
}
