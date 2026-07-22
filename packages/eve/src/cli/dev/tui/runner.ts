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
} from "#client/index.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { subscribeDevelopmentSandboxPrewarmLogs } from "#execution/sandbox/development-prewarm.js";
import {
  createDevelopmentRuntimeArtifactRefresher,
  type DevelopmentRuntimeArtifactRefresher,
} from "#services/dev-client.js";
import { toErrorMessage } from "#shared/errors.js";
import { SubagentPump, type SubagentPumpOptions, type SubagentView } from "./subagent-pump.js";
export type {
  SubagentRun,
  SubagentStepUpdate,
  SubagentToolUpdate,
  SubagentView,
} from "./subagent-pump.js";
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

import { pickAgentHeaderTip } from "./agent-header.js";
import { probeAgentInfo } from "./agent-info-probe.js";
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
import {
  createMcpConnectionStatusTracker,
  type McpConnectionProbe,
  type McpConnectionStatusTracker,
} from "./mcp-connection-status.js";
import type { detectProjectIdentity } from "#setup/project-resolution.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "#setup/vercel-project.js";
import type { DevDiagnostics } from "../diagnostics.js";

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
  | { type: "tool-call-preparing"; toolCallId: string; toolName: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; errorText: string }
  | { type: "tool-rejected"; toolCallId: string; reason: string }
  | { type: "error"; errorText: string; hint?: string; detail?: string }
  | { type: "finish"; usage?: AgentTUIStreamUsage };

export type AgentTUITurnState = {
  aborted?: boolean;
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
   * Commits the session boundary (`┌── Session restarted, clear context.`)
   * when a dead session is replaced mid-conversation. Optional; renderers
   * without it get the plain notice.
   */
  renderSessionBoundary?(): void;
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
  /**
   * Leaves the current setup panel mounted for the next automatic onboarding
   * command. The runner closes it if no next command can proceed.
   */
  readonly keepSetupFlowOpen?: true;
  readonly remoteConnection?: RemoteConnectionController;
  readonly disabledConnectionReasons?: Readonly<Record<string, string>>;
}

/** What one handled slash command leaves behind for the runner to apply. */
export interface PromptCommandOutcome {
  /** Outcome line rendered under the echoed command; absent renders nothing. */
  message?: string;
  /** Post-command work after setup settles. */
  effect?: VercelStatusEffect | { kind: "connection-added" } | { kind: "model-access-changed" };
}

export interface PromptCommandHandler {
  handle(
    command: Extract<PromptCommand, { type: "extension" }>,
    context: PromptCommandHandlerContext,
  ): Promise<PromptCommandOutcome | undefined>;
}

export type EveTUIRunnerOptions = TuiDisplayOptions & {
  session: ClientSession;
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
  /**
   * Seeds the editable prompt buffer for the first prompt. A bare local
   * `/model` starts initial model onboarding.
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
  /** Parent-owned diagnostics recorder; omitted for remote and test renderers. */
  diagnostics?: DevDiagnostics;
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
  readonly #runtimeArtifacts?: DevelopmentRuntimeArtifactRefresher;
  readonly #serverUrl?: string;
  readonly #appRoot?: string;
  /**
   * Seeds the first prompt's editable buffer. A bare local `/model` starts
   * fresh-agent onboarding.
   */
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
  readonly #mcpConnectionStatus?: McpConnectionStatusTracker;
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
  readonly #subagentPump: SubagentPump;
  /**
   * callId → AbortController for the parallel child-session stream pump
   * launched on `subagent.called`. Cancelled on `subagent.completed`, when
   * the session resets, or when the runner shuts down.
   */
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
    const pumpOptions: SubagentPumpOptions = { formatActionResultError };
    if (this.#client !== undefined) pumpOptions.client = this.#client;
    if (this.#renderer.subagents !== undefined) pumpOptions.view = this.#renderer.subagents;
    this.#subagentPump = new SubagentPump(pumpOptions);
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
      const client = this.#client;
      if (client !== undefined) {
        try {
          const probe = await devBootPhase(
            "connecting to agent",
            () => probeAgentInfo({ client }),
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
      this.#subagentPump.abortAll();
      // Restore captured stdout/stderr before a fatal error reaches the CLI.
      this.#unsubscribeDevelopmentSandboxLogs?.();
      this.#unsubscribeDevelopmentSandboxLogs = undefined;
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
    let streamWithoutPrompt = false;
    // `--input` seed: applied to the first prompt's editable buffer, then
    // cleared so later prompts open empty.
    let initialDraft = this.#initialInput;

    await this.#renderAgentHeader();
    if (this.#remoteConnection?.current().connection.state === "auth-required") {
      await this.#executeExtensionCommand(
        { type: "extension", name: "vc:login", argument: "" },
        title,
        { trigger: "startup" },
      );
    }
    this.#subscribeDevelopmentSandboxLogs();
    // Fire-and-forget: the link identity is network-bound to resolve, and the
    // first prompt must not wait on it. The segment appears when it lands.
    this.#vercelStatus?.refreshIdentity();
    this.#mcpConnectionStatus?.refresh();

    const initialCommand =
      this.#initialInput === undefined ? undefined : parsePromptCommand(this.#initialInput);
    const initialModelOnboarding =
      initialCommand?.type === "extension" &&
      initialCommand.name === "model" &&
      initialCommand.argument === "" &&
      this.#appRoot !== undefined &&
      this.#promptCommandHandler !== undefined &&
      this.#renderer.setupFlow !== undefined;
    if (initialModelOnboarding) {
      initialDraft = undefined;
      await this.#runInitialModelOnboarding(title);
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

      let result = await this.#streamTurn({
        prompt: streamWithoutPrompt ? undefined : prompt,
        inputResponses: pendingInputResponses,
      });
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

            if (responses.length === 0) {
              // Every pending question was dismissed without an answer. Fall
              // back to the prompt rather than resuming with an empty
              // response set: the turn stays parked, and the user's next
              // message resumes it with the unanswered requests recorded as
              // `ignored` (the server's continued-without-responding path).
              break;
            }

            streamWithoutPrompt = true;
            pendingInputResponses = responses;
            prompt = undefined;
            respondedToInputRequest = true;
            break;
          }

          if (this.#enterPendingConnectionAuthorization(result)) {
            result = this.#streamConnectionAuthorization();
            submittedPrompt = undefined;
            continue;
          }

          if (result.turnState && result.turnState.boundaryEvent === undefined) {
            if (result.turnState.aborted) {
              this.#sessionFailed = true;
            } else {
              const strandedSessionId = this.#session.state.sessionId;
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

      streamWithoutPrompt = false;
      pendingInputResponses = undefined;
      prompt = undefined;

      // The session ended terminally this turn (session.failed, a dispatch
      // failure, or a user interrupt). Replace it with a fresh one so the
      // next prompt isn't sent into a dead session, but keep the transcript
      // on screen. Server-side context is gone with the old session.
      if (this.#sessionFailed) {
        this.#sessionFailed = false;
        this.#startNewSession();
        // An aborted turn keeps its explicit notice — the boundary line alone
        // would hide that the interrupted turn may still run on the server.
        if (result.turnState?.aborted) {
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
    }
  }

  /**
   * Resets all per-conversation runner state and, when a client is
   * available, replaces the active session with a fresh one so the next
   * turn starts a new server-side conversation. Backs the `/new` command.
   * In-flight subagent child-session streams are aborted.
   */
  #startNewSession(): void {
    this.#subagentPump.abortAll();
    this.#pendingInputRequests.clear();
    this.#connectionAuthRuns.clear();
    this.#pendingConnectionAuths.clear();
    this.#renderer.setConnectionAuthPendingCount?.(0);

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
    const runtimeArtifacts = this.#runtimeArtifacts;
    if (runtimeArtifacts === undefined) {
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
        await runtimeArtifacts.refreshIdle({
          onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
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

    return this.#createTUIStreamResult(response, () => abortController.abort());
  }

  /**
   * Follows the same session after an interactive authorization callback.
   * `send()` stops at the parked `session.waiting` boundary; the callback's
   * completion events arrive in the next durable turn on `session.stream()`.
   */
  #streamConnectionAuthorization(): AgentTUIStreamResult {
    const abortController = new AbortController();
    return this.#createTUIStreamResult(
      this.#session.stream({ signal: abortController.signal }),
      () => abortController.abort(),
    );
  }

  #createTUIStreamResult(
    events: AsyncIterable<HandleMessageStreamEvent>,
    abort: () => void,
  ): AgentTUIStreamResult {
    const turnState = createTurnState();
    return {
      abort: () => {
        turnState.aborted = true;
        abort();
      },
      events: eveEventsToTUIStream({
        events,
        pendingInputRequests: this.#pendingInputRequests,
        turnState,
        onSubagentCalled: (called) => this.#subagentPump.begin(called),
        onSubagentCompleted: (callId) => this.#subagentPump.settle(callId),
        onConnectionAuthRequired: (event) => this.#handleConnectionAuthRequired(event),
        onConnectionAuthCompleted: (event) => this.#handleConnectionAuthCompleted(event),
        onTerminalFailure: () => {
          this.#sessionFailed = true;
        },
        failureHintOverride: this.#appRoot === undefined ? undefined : localFailureHint,
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
    input: Pick<PromptCommandHandlerContext, "initialModelStep" | "keepSetupFlowOpen" | "title">,
  ): Promise<PromptCommandOutcome | undefined> {
    const handler = this.#promptCommandHandler;
    if (handler === undefined)
      return { message: `/${command.name} is not available in this session.` };

    const baseContext: PromptCommandHandlerContext = {
      renderer: this.#renderer,
      title: input.title,
      initialModelStep: input.initialModelStep,
      remoteConnection: this.#remoteConnection,
    };
    const disabledConnectionReasons = this.#mcpConnectionStatus?.current();
    const context: PromptCommandHandlerContext =
      disabledConnectionReasons !== undefined && Object.keys(disabledConnectionReasons).length > 0
        ? { ...baseContext, disabledConnectionReasons }
        : baseContext;
    if (input.keepSetupFlowOpen === true) {
      return await handler.handle(command, { ...context, keepSetupFlowOpen: true });
    }
    return await handler.handle(command, context);
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
    if (effect?.kind === "connection-added") {
      this.#vercelStatus?.applyEffect({ kind: "refresh-identity" });
      this.#authHintStale = true;
      await this.#refreshConnectionRuntime();
      await this.#refreshModelAccess();
      return;
    }
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

  async #refreshConnectionRuntime(): Promise<void> {
    const runtimeArtifacts = this.#runtimeArtifacts;
    if (runtimeArtifacts === undefined) return;

    await runtimeArtifacts.refreshAfterSourceChange({
      onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
    });
  }

  async #executeExtensionCommand(
    command: Extract<PromptCommand, { type: "extension" }>,
    title: string,
    input: {
      readonly trigger: "startup" | "command";
      readonly initialModelStep?: "provider";
      readonly keepSetupFlowOpen?: true;
    },
  ): Promise<void> {
    const outcome = await this.#handleExtensionCommand(command, {
      initialModelStep: input.initialModelStep,
      keepSetupFlowOpen: input.keepSetupFlowOpen,
      title,
    });
    this.#renderStartupCommandInvocation(command, input.trigger);
    this.#renderCommandOutcome(outcome?.message);
    await this.#applyCommandEffect(outcome?.effect);
    this.#refreshHeaderFromRemoteConnection();
  }

  /**
   * Fresh `eve init` launches the TUI with `/model` prefilled. Project-backed
   * model access depends on the Vercel CLI and a Vercel session, so resolve
   * only those missing prerequisites before entering the model picker. A probe
   * failure still opens `/model`: its own-key and external-provider paths do
   * not require Vercel.
   */
  async #runInitialModelOnboarding(title: string): Promise<void> {
    const appRoot = this.#appRoot;
    if (appRoot === undefined) return;

    const authStatus = async (): Promise<VercelAuthStatus | undefined> => {
      try {
        return await this.#getVercelAuthStatus(appRoot, { signal: this.#authProbeAbort.signal });
      } catch {
        return undefined;
      }
    };

    let status = await authStatus();
    if (status === "cli-missing") {
      await this.#executeExtensionCommand(
        { type: "extension", name: "vc:install", argument: "" },
        title,
        { trigger: "startup", keepSetupFlowOpen: true },
      );
      status = await authStatus();
      if (status === "cli-missing") {
        this.#renderer.setupFlow?.end();
        return;
      }
    }

    if (status === "logged-out") {
      await this.#executeExtensionCommand(
        { type: "extension", name: "vc:login", argument: "" },
        title,
        { trigger: "startup", keepSetupFlowOpen: true },
      );
      status = await authStatus();
      if (status === "cli-missing" || status === "logged-out") {
        this.#renderer.setupFlow?.end();
        return;
      }
    }

    await this.#executeExtensionCommand({ type: "extension", name: "model", argument: "" }, title, {
      trigger: "startup",
      initialModelStep: "provider",
    });
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
    const client = this.#client;
    if (client === undefined) return;

    const probe = await probeAgentInfo({ client });
    return probe.kind === "ready" ? probe.info : undefined;
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
      this.#pendingConnectionAuths.add(run.name);
      this.#emitConnectionAuthUpdate(run);
      added = true;
    }

    if (added) {
      this.#renderer.setConnectionAuthPendingCount?.(this.#pendingConnectionAuths.size);
    }
    return this.#pendingConnectionAuths.size > 0;
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
    diagnostics: options.diagnostics,
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
  turnState: AgentTUITurnState;
  onSubagentCalled?: (event: SubagentCalledStreamEvent) => void;
  onSubagentCompleted?: (callId: string) => void;
  onConnectionAuthRequired?: (event: AuthorizationRequiredStreamEvent) => void;
  onConnectionAuthCompleted?: (event: AuthorizationCompletedStreamEvent) => void;
  onTerminalFailure?: (event: SessionFailedStreamEvent) => void;
  /**
   * Replaces a failure's structured hint with a surface-local one (the
   * local TUI swaps gateway-auth remediation for the in-session `/model`
   * fix). Returning `undefined` keeps the hint the harness attached.
   */
  failureHintOverride?: (event: FailureStreamEvent) => string | undefined;
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
    turnState,
    onSubagentCalled,
    onSubagentCompleted,
    onConnectionAuthRequired,
    onConnectionAuthCompleted,
    onTerminalFailure,
    failureHintOverride,
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
  const seenInputRequestIds = new Set<string>();
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

          if (seenInputRequestIds.has(request.requestId)) continue;
          seenInputRequestIds.add(request.requestId);
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
        if (!knownToolCalls.has(callId)) {
          // Results for calls this turn never announced (e.g. subagent
          // dispatches, which surface through the subagent section instead)
          // have no tool block to attach to.
          break;
        }
        switch (resultEvent.data.status) {
          case "completed":
            yield {
              type: "tool-result",
              toolCallId: callId,
              output: resultEvent.data.result.output,
            };
            break;
          case "failed":
            yield {
              type: "tool-error",
              toolCallId: callId,
              errorText: formatActionResultError(resultEvent),
            };
            break;
          case "rejected":
            yield {
              type: "tool-rejected",
              toolCallId: callId,
              reason: formatActionResultError(resultEvent),
            };
            break;
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
        // Run creation (idempotent for SSE-resume re-entries) lives in the
        // pump's begin().
        onSubagentCalled?.(event as SubagentCalledStreamEvent);
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
    aborted: false,
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
