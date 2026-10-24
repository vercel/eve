import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "#protocol/interaction-options.js";
import {
  activeTurn,
  delivery,
  turn as readTurn,
  task,
  openInteractions,
  failure,
} from "#protocol/session-projection/public-view.js";
import type { Interaction } from "#protocol/session-projection/reader.js";
import type { Delivery } from "#shared/delivery.js";
import { optionStyle } from "#channel/interaction-prompts.js";
import { type ConversationState } from "#client/conversation-state.js";
import { attachSessionStore, detachSessionStore, SessionStore } from "#client/session-store.js";
import { isAbortError } from "#client/session-store-helpers.js";
import { formatStrandedSessionNotice } from "./stranded-session.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";
import { isTaskAdmissionRefused } from "#protocol/task-tools.js";
import type { SendTurnPayload } from "#client/types.js";
import type { ModelAccessChange } from "#shared/model-connection.js";
import type { AgentInfoResult, Client, SessionStreamEvent } from "#client/index.js";
import type { InteractionOption } from "#protocol/session-events/families/interaction.js";
import type { Answer } from "#shared/input.js";
import { renderApplicationInfo } from "#cli/commands/info.js";
import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";
import type { OnboardingScreenEvent } from "./setup-commands.js";
import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import {
  createDevelopmentRuntimeArtifactRefresher,
  type DevelopmentRuntimeArtifactRefresher,
} from "#services/dev-client.js";
import { inspectApplication } from "#services/inspect-application.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  conversationView,
  isWorking,
  tuiSessionData,
  type AgentTUIConversationView,
  type TuiFailure,
} from "./conversation-view.js";
import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";

import {
  formatFailureDetail,
  formatFailureMessage,
  interruptedError,
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
import type { LogDisplayMode, TuiDisplayOptions } from "./types.js";
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

const idleRuntimeArtifactPollMs = 500;
const idleChatGptAuthPollMs = 5_000;

export type AgentTUISessionOptions = {
  title?: string;
  /**
   * Text to seed the composer's draft with before the user types. Set by the
   * runner for the first prompt when `eve dev --input` is used.
   */
  initialDraft?: string;
  /** Closes the composer without discarding its draft. */
  signal?: AbortSignal;
};

/** One user action from the composer. */
export type AgentTUIInput =
  /** A message or slash command. Messages sent while work runs steer it. */
  | { type: "submit"; text: string }
  /** `Esc` or `Ctrl+C` while work runs. */
  | { type: "cancel" }
  /** `Ctrl+C` again while cancellation is pending: stop following the turn. */
  | { type: "interrupt" };

/** Where a prompt sits among the requests being answered, and who asked, when that helps. */
export type AgentTUIInputContext = {
  /** 1-based position among the requests answered in a row; the total grows as more arrive. */
  position?: { index: number; total: number };
  /** The task that asked, named as its transcript lines are. */
  requester?: string;
  /** The task whose run asked; the renderer names it as its task lines do. */
  taskId?: string;
};

export type AgentTUIToolApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  /** The server's question for this approval, such as `Approve Deploy release?`. */
  prompt: string;
  input: unknown;
  context?: AgentTUIInputContext;
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
  context?: AgentTUIInputContext;
};

export type AgentTUIInputQuestionResponse = {
  optionId?: string;
  text?: string;
};

export type AgentTUIAgentHeader = {
  name: string;
  serverUrl: string;
  info?: AgentInfoResult;
  localDevelopment?: boolean;
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
   * Puts back a message whose turn was cancelled from outside this prompt, such as `/cancel` from
   * another client, when the composer is empty. Optional.
   */
  restoreDraft?(text: string): void;
  /**
   * Commits the session boundary (`┌── Session restarted, clear context.`)
   * when a dead session is replaced mid-conversation. The old conversation's
   * transcript settles as shown; the next `renderConversation` starts fresh.
   * Optional; renderers without it get the plain notice.
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
  /**
   * Reads the next composer action. Resolves `undefined` when `signal`
   * aborts and rejects with an interrupt when the user leaves.
   */
  readInput?(options?: AgentTUISessionOptions): Promise<AgentTUIInput | undefined>;
  /** Draws the session's transcript from one conversation snapshot. */
  renderConversation?(view: AgentTUIConversationView): void;
  /** Commits one error block, such as a message the session did not accept. */
  renderError?(title: string, message: string): void;
  /**
   * Reports the server session id backing the conversation — pushed by the
   * runner once a send is accepted, and overwritten when a later session's
   * turn is accepted. Deliberately sticky across `/new` and interrupt
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
   * `/new` command to start a new session with a clean slate.
   */
  reset?(): void;
  /**
   * Tears down interactive mode and restores the terminal when the runner's
   * lifecycle ends.
   */
  shutdown?(): void;
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
  /** Production TUI probe injected by the launcher; omitted in hermetic runners. */
  probeMcpConnection?: McpConnectionProbe;
  /** Configured client for the conversation's sessions and their subagent streams. */
  client: Client;
  renderer?: AgentTUIRenderer;
  screen?: TerminalOutput;
  userInput?: TerminalInput;
  /**
   * Formats a session error (a failed send — e.g. a transport failure or a
   * Vercel Deployment Protection challenge) into the text rendered in the
   * inline error region. Defaults to the error's message. Callers that know
   * about transport-specific challenges (the `eve dev` glue) inject a richer
   * formatter here.
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

/** A turn waiting on a person is open while the store is idle, so it still takes steering and Stop. */
function hasOpenTurn(snapshot: SessionStore["snapshot"]): boolean {
  return activeTurn(snapshot.view) !== undefined;
}

export class EveTUIRunner {
  readonly #client: Client;
  /** Owns the conversation's sessions, root stream, turns, and subagent streams. */
  readonly #store: SessionStore;
  /** The terminal's presentation facts, folded from the store's events. */
  readonly #renderer: AgentTUIRenderer;
  readonly #diagnostics?: DevDiagnostics;
  readonly #name: string;
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
  /** The message this TUI last sent, until its turn settles. */
  #sentMessage?: { readonly text: string; deliveryId?: string };
  /** Whether this TUI asked to cancel the turn of {@link #sentMessage}. */
  #cancelRequested = false;
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
  /** Closes the composer when something else needs the keyboard. */
  #inputController?: AbortController;
  /** Questions the user skipped; they stay open for the server to resolve. */
  readonly #dismissedInputs = new Set<string>();
  /** Questions answered here that stay open until the session settles them. */
  readonly #answeredInputs = new Set<string>();
  /** Registry setups queued by tool results on root or child streams. */
  readonly #pendingRegistrySetups: string[] = [];
  #activeRegistrySetup?: string;
  /** Tool calls whose registry handoff was already queued. */
  readonly #handledHandoffs = new Set<string>();
  /** The last session error shown, so each renders once. */
  #reportedError?: Error;
  /** Failure cascades already recorded in diagnostics this turn. */
  /** How many of the session's failures the diagnostics log already has. */
  #recordedFailures = 0;
  readonly #recordedAgentToolFailures = new Set<string>();
  /** Calls' names from their requests: a call can settle in the commit that requests it. */
  readonly #callNames = new Map<string, string>();
  readonly #lifecycle?: CommandLifecycle;

  constructor(options: EveTUIRunnerOptions) {
    this.#client = options.client;
    if (options.lifecycle !== undefined) this.#lifecycle = options.lifecycle;
    if (options.diagnostics !== undefined) this.#diagnostics = options.diagnostics;
    this.#renderer = createRenderer(options);
    this.#store = new SessionStore({
      client: options.client,
      followAgents: true,
    });
    this.#store.setCallbacks({
      onEvent: (event) => this.#recordDiagnostics(event),
      onSessionChange: (session) => {
        if (session !== undefined) this.#renderer.setSessionId?.(session.sessionId);
      },
      prepareSend: (input) => this.#prepareSend(input),
    });
    this.#name = options.name ?? "eve";
    this.#withExclusiveTerminal = options.withExclusiveTerminal;
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
      localDevelopment: this.#appRoot !== undefined,
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
    const unsubscribe = this.#store.subscribe(() => this.#renderSnapshot());
    attachSessionStore(this.#store);
    try {
      await this.#run();
    } catch (error) {
      if (!isInterruptedError(error)) throw error;
    } finally {
      this.#lifecycle?.signal.removeEventListener("abort", onStop);
      this.#disposed = true;
      this.#authProbeAbort.abort();
      this.#inputController?.abort();
      unsubscribe();
      detachSessionStore(this.#store);
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

    // One loop for everything that takes the keyboard. The store streams the
    // session throughout, so the composer stays open while work runs.
    while (this.#lifecycle?.signal.aborted !== true && this.#renderer.exitRequested?.() !== true) {
      if (this.#sessionFailed()) {
        this.#replaceSession();
        continue;
      }
      // Answering first lets the agent continue while setup owns the terminal.
      if (this.#answerableInputs().length > 0) {
        await this.#answerInputs(title);
        continue;
      }
      // Setup takes the terminal, so it waits for the session to settle.
      const registrySetup = isWorking(this.#store.snapshot.status)
        ? undefined
        : this.#pendingRegistrySetups.shift();
      if (registrySetup !== undefined) {
        this.#activeRegistrySetup = registrySetup;
        try {
          await this.#openRegistrySetup(registrySetup);
        } finally {
          this.#activeRegistrySetup = undefined;
        }
        continue;
      }
      if (prompt === undefined) {
        const input = await this.#readInput({ title, initialDraft });
        initialDraft = undefined;
        if (input === undefined) continue;
        if (input.type === "cancel") {
          this.#cancelTurn();
          continue;
        }
        if (input.type === "interrupt") {
          this.#replaceSession(
            "Stopped following the turn and started a new session. Earlier context was cleared; the interrupted turn may still be running on the server.",
          );
          continue;
        }
        prompt = input.text;
      }
      const text = prompt;
      prompt = undefined;
      const command = parsePromptCommand(text);
      if (command === null) {
        this.#submitMessage(text);
        continue;
      }
      const outcome = await this.#runCommand(command, title);
      if (outcome === "exit") return;
      if (outcome !== undefined) initialDraft = outcome.draft;
    }
  }

  /** Runs one slash command; returns `"exit"` or a draft for the next prompt. */
  async #runCommand(
    command: PromptCommand,
    title: string,
  ): Promise<"exit" | { draft: string } | undefined> {
    switch (command.type) {
      case "exit":
        this.#finishCommand({ kind: "dismiss" });
        this.#lifecycle?.requestStop();
        return "exit";
      case "cancel": {
        const working = hasOpenTurn(this.#store.snapshot);
        if (working) this.#cancelTurn();
        this.#finishCommand({
          kind: "result",
          summary: working ? "Cancellation requested" : "No active turn to cancel",
        });
        return;
      }
      case "new":
        await this.#resetSession();
        return;
      case "compact":
        await this.#runSessionCommand({
          absent: "No active session to compact",
          accepted: "Compaction requested",
          failed: "Couldn't compact the session",
          invoke: () => this.#store.compact(),
        });
        return;
      case "clear":
        await this.#runSessionCommand({
          absent: "No active session to clear",
          accepted: "Session context cleared",
          failed: "Couldn't clear the session",
          invoke: () => this.#store.clear(),
        });
        return;
      // Help renders locally; unlike extension commands it must work even
      // without a prompt-command handler (e.g. remote --url sessions).
      case "help": {
        if (this.#renderer.choosePromptCommand === undefined) {
          this.#finishCommand({
            kind: "result",
            message: formatPromptCommandHelp(this.#availablePromptCommands),
          });
          return;
        }
        const selected = await this.#renderer.choosePromptCommand(this.#availablePromptCommands);
        return selected === undefined ? undefined : { draft: selected };
      }
      case "info":
        await this.#showApplicationInfo();
        return;
      // Like /help, /loglevel renders locally: it adjusts the renderer's own
      // log filter, so it works without a prompt-command handler.
      case "loglevel": {
        const outcome = this.#applyLogLevelCommand(command.argument);
        const error =
          outcome.startsWith("/loglevel is not available") ||
          outcome.startsWith("Unknown log level");
        this.#finishCommand(
          error ? { kind: "result", message: outcome } : { kind: "result", summary: outcome },
        );
        return;
      }
      // /traces is renderer-local too: the viewer reads the local spool from
      // disk and owns the screen until the user closes it.
      case "traces":
        await this.#openTraceViewer(command.argument);
        return;
      case "extension":
        await this.#executeExtensionCommand(command, title, { trigger: "command" });
        return;
    }
  }

  /** Sends a message; while work runs it steers the active turn instead. */
  #submitMessage(message: string): void {
    const snapshot = this.#store.snapshot;
    const steering = hasOpenTurn(snapshot);
    const sent: { text: string; deliveryId?: string } = { text: message };
    this.#sentMessage = sent;
    if (!steering) this.#cancelRequested = false;
    const input: SendTurnPayload = steering
      ? { message, turnPolicy: "steer" }
      : snapshot.session === undefined
        ? { message }
        : { message, turnPolicy: "queue" };
    void this.#store
      .send(input)
      .then(({ deliveryId }) => {
        sent.deliveryId = deliveryId;
        if (!this.#disposed) this.#restoreCancelledMessage(this.#store.snapshot);
      })
      .catch((error: unknown) => {
        if (this.#disposed || isAbortError(error)) return;
        this.#renderSendError(steering ? "Steering failed" : "Error", error);
      });
  }

  /** Refreshes local dev artifacts so a new turn runs the latest authored code. */
  async #prepareSend(input: SendTurnPayload): Promise<SendTurnPayload> {
    // A steered message joins the running turn, which keeps its artifacts.
    if (input.turnPolicy === "steer") return input;
    if (this.#runtimeArtifacts !== undefined) {
      await this.#runtimeArtifacts.refresh({
        answers: input.answers,
        message: typeof input.message === "string" ? input.message : undefined,
        onRuntimeArtifactsChanged: () => this.#handleRuntimeArtifactsChanged(),
      });
    }
    if (input.message !== undefined) this.#renderer.flushDelayedDevBuildErrors?.();
    return input;
  }

  #renderSnapshot(): void {
    const snapshot = this.#store.snapshot;
    const data = tuiSessionData(snapshot);
    this.#renderer.renderConversation?.(
      conversationView(snapshot, data, this.#appRoot === undefined ? undefined : localFailureHint),
    );
    this.#reportSessionError(snapshot.error, data.sessionFailed);
    this.#recordFailures(data.failures);
    this.#recordAgentToolFailures(snapshot);
    this.#reportFirstResponse(snapshot);
    this.#queueRegistryHandoffs(snapshot);
    this.#restoreCancelledMessage(snapshot);
    if (
      data.sessionFailed ||
      this.#answerableInputs().length > 0 ||
      (!isWorking(snapshot.status) && this.#pendingRegistrySetups.length > 0)
    ) {
      this.#inputController?.abort();
    }
  }

  #sessionFailed(): boolean {
    return tuiSessionData(this.#store.snapshot).sessionFailed;
  }

  /** A turn cancelled from outside this prompt hands its message back instead of losing it. */
  #restoreCancelledMessage(conversation: ConversationState): void {
    const sent = this.#sentMessage;
    if (sent?.deliveryId === undefined) return;
    const turnId = delivery(conversation.view, sent.deliveryId)?.turnId;
    if (turnId === undefined) return;
    const turn = readTurn(conversation.view, turnId);
    if (turn === undefined || turn.status === "running") return;
    const status = turn.outcome;
    this.#sentMessage = undefined;
    // A failure cancels its turn too; the failure shows, and the message isn't handed back.
    if (
      status === "cancelled" &&
      !this.#cancelRequested &&
      failure(conversation.view, turnId) === undefined
    )
      this.#renderer.restoreDraft?.(sent.text);
  }

  /** Session failures render from the conversation; other errors get one block each. */
  #reportSessionError(error: Error | undefined, sessionFailed: boolean): void {
    if (error === undefined || error === this.#reportedError) return;
    this.#reportedError = error;
    if (sessionFailed) return;
    // A stranded session is a property of that session, not of the connection.
    if (!this.#renderStrandedSession(error)) {
      this.#remoteConnection?.reportFailure(error);
      this.#renderer.renderError?.("Error", this.#formatTransportError(error));
    }
  }

  #renderSendError(title: string, error: unknown): void {
    if (this.#renderStrandedSession(error)) return;
    this.#renderer.renderError?.(title, this.#formatTransportError(error));
  }

  #strandedSessionNotice(error: unknown): string | undefined {
    return formatStrandedSessionNotice(error, {
      localServer: this.#appRoot !== undefined,
      sessionId: this.#store.snapshot.session?.sessionId,
    });
  }

  /** Renders a stranded-session notice; false when `error` is anything else. */
  #renderStrandedSession(error: unknown): boolean {
    const notice = this.#strandedSessionNotice(error);
    if (notice === undefined) return false;
    this.#renderer.renderError?.("Session stranded", notice);
    return true;
  }

  #reportFirstResponse(conversation: ConversationState): void {
    if (!this.#onboard || this.#reportedFirstResponse) return;
    const responded = conversation.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.type === "text" && part.text.length > 0),
    );
    if (!responded) return;
    this.#reportedFirstResponse = true;
    this.#onOnboardingStep?.({ flow: "onboarding", step: "first_response" });
  }

  /** Open requests the user can answer now, including while other work runs. */
  #answerableInputs(): readonly Interaction[] {
    // A sign-in completes by its callback, not an answer typed here.
    return openInteractions(this.#store.snapshot.view).filter(
      (input) =>
        input.request.kind !== "sign-in" &&
        !this.#dismissedInputs.has(input.interactionId) &&
        !this.#answeredInputs.has(input.interactionId),
    );
  }

  /**
   * Prompts for open requests one at a time and sends each answer as it is given, so an agent
   * waiting on one answer resumes without waiting for the rest.
   */
  async #answerInputs(title: string): Promise<void> {
    for (let answered = 0; ; answered += 1) {
      const inputs = this.#answerableInputs();
      const input = inputs[0];
      if (input === undefined) return;
      const context = inputContext(input, answered + 1, answered + inputs.length);
      const response = await this.#readAnswer(input, context, title);
      if (response === undefined) {
        // A skipped question stays open; the server decides whether the
        // user's next message answers, dismisses, or leaves it.
        this.#dismissedInputs.add(input.interactionId);
        continue;
      }
      this.#answeredInputs.add(input.interactionId);
      void this.#store.send({ answers: [response] }).catch((error: unknown) => {
        this.#answeredInputs.delete(input.interactionId);
        if (this.#disposed || isAbortError(error)) return;
        this.#renderSendError("Error", error);
      });
    }
  }

  async #readAnswer(
    request: Interaction,
    context: AgentTUIInputContext | undefined,
    title: string,
  ): Promise<Answer | undefined> {
    if (request.request.kind === "approval") {
      if (!this.#renderer.readToolApproval) {
        throw new Error(
          "Tool approval was requested, but the renderer does not support tool approval input.",
        );
      }
      const response = await this.#renderer.readToolApproval(
        toAgentTUIToolApprovalRequest(request, context),
        { title },
      );
      return {
        interactionId: request.interactionId,
        optionId: response.approved ? APPROVE_OPTION_ID : DENY_OPTION_ID,
      };
    }
    if (!this.#renderer.readInputQuestion) {
      throw new Error(
        "An interactive question was requested, but the renderer does not support input questions.",
      );
    }
    const response = await this.#renderer.readInputQuestion(
      toAgentTUIInputQuestion(request, context),
      { title },
    );
    if (response === undefined) return undefined;
    return {
      interactionId: request.interactionId,
      ...(response.optionId !== undefined && { optionId: response.optionId }),
      ...(response.text !== undefined && { text: response.text }),
    } satisfies Answer;
  }

  /**
   * Starts a fresh session after the current one ended or was abandoned. The
   * transcript stays on screen; server-side context is gone with the old
   * session.
   */
  #replaceSession(notice?: string): void {
    if (this.#renderer.renderSessionBoundary !== undefined) {
      this.#renderer.renderSessionBoundary();
    } else if (notice === undefined) {
      this.#renderer.renderNotice?.(
        "Session ended — started a new session. Earlier context was cleared.",
      );
    }
    if (notice !== undefined) this.#renderer.renderNotice?.(notice);
    this.#resetConversation();
  }

  #resetConversation(): void {
    this.#store.newSession();
    this.#clearRunnerState();
  }

  #clearRunnerState(): void {
    this.#dismissedInputs.clear();
    this.#answeredInputs.clear();
    this.#handledHandoffs.clear();
    this.#callNames.clear();
    this.#recordedFailures = 0;
    this.#runtimeArtifacts?.clear();
  }

  /** Cancels the running turn without holding the composer; the store waits for its turn ID. */
  #cancelTurn(): void {
    this.#cancelRequested = true;
    void this.#store.cancel().catch((error: unknown) => {
      this.#renderer.renderNotice?.(`Couldn't cancel the turn: ${toErrorMessage(error)}`);
    });
  }

  /** Runs a session mutation and gives every control command one completion policy. */
  async #runSessionCommand(input: {
    readonly absent: string;
    readonly accepted: string;
    readonly failed: string;
    readonly invoke: () => Promise<Delivery>;
  }): Promise<void> {
    if (this.#store.snapshot.session === undefined) {
      this.#finishCommand({ kind: "result", summary: input.absent });
      return;
    }
    try {
      const result = await (await input.invoke()).result();
      if (result.status !== "completed") throw new Error(`The command settled ${result.status}.`);
      this.#finishCommand({ kind: "result", summary: input.accepted });
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: this.#strandedSessionNotice(error) ?? toErrorMessage(error),
        summary: input.failed,
      });
    }
  }

  /** Retires the durable session before clearing the local conversation view. */
  async #resetSession(): Promise<void> {
    try {
      if (this.#store.snapshot.session !== undefined) await (await this.#store.reset()).result();
      this.#store.newSession();
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: `Couldn't reset the session: ${toErrorMessage(error)}`,
      });
      return;
    }
    this.#clearRunnerState();
    this.#renderer.reset?.();
    this.#finishCommand({ kind: "dismiss" });
  }

  /**
   * Reads the composer, closing it when a request or setup needs the keyboard.
   * Resolves `undefined` only for that runner-owned close; a renderer that
   * ends input on its own ends the session.
   */
  async #readInput(options: AgentTUISessionOptions): Promise<AgentTUIInput | undefined> {
    if (!this.#renderer.readInput) {
      throw new Error("The renderer does not support prompt input.");
    }
    const controller = new AbortController();
    this.#inputController = controller;
    try {
      const input = await this.#withIdleRefresh(
        this.#renderer.readInput({ ...options, signal: controller.signal }),
      );
      if (input === undefined && !controller.signal.aborted) throw interruptedError();
      return input;
    } finally {
      if (this.#inputController === controller) this.#inputController = undefined;
    }
  }

  /** Polls local dev artifacts while the composer is open, so HMR stays current. */
  async #withIdleRefresh<T>(prompt: Promise<T>): Promise<T> {
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

  /** Queues setup for registry items whose install needs the terminal. */
  #queueRegistryHandoffs(conversation: ConversationState): void {
    if (this.#appRoot === undefined) return;
    for (const { callId, address } of registryHandoffs(conversation)) {
      if (this.#handledHandoffs.has(callId)) continue;
      this.#handledHandoffs.add(callId);
      if (this.#activeRegistrySetup === address || this.#pendingRegistrySetups.includes(address)) {
        continue;
      }
      this.#pendingRegistrySetups.push(address);
    }
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
        sessionId: this.#store.snapshot.session?.sessionId,
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
   * Applies `/loglevel [none|error|warn|debug|all]` against the renderer's buffered
   * log filter and returns the one-line outcome. A bare `/loglevel` reports
   * the current mode instead of changing it.
   */
  #applyLogLevelCommand(argument: string): string {
    const renderer = this.#renderer;
    if (renderer.logDisplayMode === undefined || renderer.setLogDisplayMode === undefined) {
      return "/loglevel is not available in this session.";
    }
    if (argument === "") {
      return `Logs: ${renderer.logDisplayMode()}. Use /loglevel none|error|warn|debug|all — logs stay buffered, so switching also hides or restores past lines.`;
    }
    const mode = parseLogDisplayMode(argument);
    if (mode === undefined) {
      return `Unknown log level "${argument}". Use none, error, warn, debug, or all.`;
    }
    if (mode === renderer.logDisplayMode()) {
      return `Logs already set to ${mode}.`;
    }
    renderer.setLogDisplayMode(mode);
    switch (mode) {
      case "none":
        return "Logs hidden. Output stays buffered — /loglevel all restores it.";
      case "error":
        return "Showing errors.";
      case "warn":
        return "Showing warnings and errors.";
      case "debug":
        return "Showing all severity-tagged logs.";
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

  /** Agents' own tool failures reach the diagnostics log whatever the subagent display mode. */
  #recordAgentToolFailures(conversation: ConversationState): void {
    const diagnostics = this.#diagnostics;
    if (diagnostics === undefined) return;
    for (const agent of Object.values(conversation.agents)) {
      if (agent.observation.status === "not-followed") continue;
      for (const message of agent.observation.conversation?.messages ?? []) {
        for (const part of message.parts) {
          if (part.type !== "tool" || part.state !== "failed") continue;
          if (this.#recordedAgentToolFailures.has(part.callId)) continue;
          this.#recordedAgentToolFailures.add(part.callId);
          diagnostics.append({
            source: "tool",
            summary: `${part.name} failed (subagent ${agent.name})`,
            detail: part.error?.message ?? "Failed.",
          });
        }
      }
    }
  }

  /** Records session activity that the diagnostics log keeps regardless of display. */
  #recordDiagnostics(event: SessionStreamEvent): void {
    const diagnostics = this.#diagnostics;
    if (diagnostics === undefined) return;
    switch (event.type) {
      case "call.requested":
        this.#callNames.set(event.data.callId, event.data.capability.name);
        if (event.data.capability.kind === "tool")
          diagnostics.recordToolCall(event.data.capability.name);
        break;
      case "call.settled": {
        const name = this.#callNames.get(event.data.callId) ?? event.data.callId;
        if (isTaskAdmissionRefused(event.data)) {
          diagnostics.append({
            source: "tool",
            summary: `${name} was refused for the model to retry`,
            detail: event.data.error?.message ?? "Refused.",
          });
        } else if (event.data.outcome === "failed") {
          diagnostics.append({
            source: "tool",
            summary: `${name} failed`,
            detail: event.data.error?.message ?? "Tool failed.",
          });
        }
        break;
      }
      // A reusable body's failure can arrive after it already replied to every call.
      case "task.ended":
        if (event.data.outcome === "failed") {
          diagnostics.append({
            source: "tool",
            summary: `${task(this.#store.snapshot.view, event.data.taskId)?.name ?? "A task"} ended with an error`,
            detail: event.data.error?.message ?? "Task failed.",
          });
        }
        break;
      case "child.opened":
        if ("callId" in event.data.owner)
          diagnostics.recordSubagentDispatch(event.data.owner.callId);
        break;
      case "usage.recorded":
        diagnostics.recordStepUsage(event.data.usage);
        break;
    }
  }

  /** Logs each failure the session shows once, as it appears. A reset session starts over. */
  #recordFailures(failures: readonly TuiFailure[]): void {
    if (failures.length < this.#recordedFailures) this.#recordedFailures = 0;
    for (const { error } of failures.slice(this.#recordedFailures)) {
      const message = formatFailureMessage(error);
      const entry = {
        detail: formatFailureDetail(error) ?? message,
        source: "workflow" as const,
        summary: `Error: ${message}`,
      };
      this.#diagnostics?.append(error.hint === undefined ? entry : { ...entry, hint: error.hint });
    }
    this.#recordedFailures = failures.length;
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

/** Tool results in the conversation that hand a registry install to the terminal. */
function registryHandoffs(
  conversation: ConversationState,
): Array<{ readonly callId: string; readonly address: string }> {
  const handoffs: Array<{ callId: string; address: string }> = [];
  const collect = (state: ConversationState, subagentName: string | undefined) => {
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (!isTerminalToolCallPart(part) || part.state !== "completed") continue;
        const address = registryHandoffAddress(subagentName, part.name, part.output);
        if (address !== undefined) handoffs.push({ callId: part.callId, address });
      }
    }
  };
  collect(conversation, undefined);
  for (const agent of Object.values(conversation.agents)) {
    if (agent.observation.status === "not-followed") continue;
    const child = agent.observation.conversation;
    if (child !== undefined) collect(child, agent.name);
  }
  return handoffs;
}

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

function inputContext(
  input: Interaction,
  index: number,
  total: number,
): AgentTUIInputContext | undefined {
  const context: AgentTUIInputContext = {};
  if (total > 1) context.position = { index, total };
  if (input.taskId !== undefined) context.taskId = input.taskId;
  return context.position === undefined && context.taskId === undefined ? undefined : context;
}

function toAgentTUIToolApprovalRequest(
  request: Interaction,
  context: AgentTUIInputContext | undefined,
): AgentTUIToolApprovalRequest {
  const approval: AgentTUIToolApprovalRequest = {
    approvalId: request.interactionId,
    toolCallId: request.call?.callId ?? request.interactionId,
    toolName: request.call?.name ?? request.request.kind,
    prompt: request.request.prompt,
    input: request.call?.input ?? {},
  };
  if (context !== undefined) approval.context = context;
  return approval;
}

function toAgentTUIInputQuestion(
  request: Interaction,
  context: AgentTUIInputContext | undefined,
): AgentTUIInputQuestion {
  const display: "select" | "text" =
    request.request.display === "text"
      ? "text"
      : request.request.display === "select"
        ? "select"
        : request.request.options !== undefined && request.request.options.length > 0
          ? "select"
          : "text";

  const question: AgentTUIInputQuestion = {
    requestId: request.interactionId,
    prompt: request.request.prompt,
    display,
  };

  if (request.request.options !== undefined) {
    question.options = request.request.options.map((option: InteractionOption) => {
      const out: AgentTUIInputOption = { id: option.id, label: option.label };
      if (option.description !== undefined) out.description = option.description;
      const style = optionStyle(option);
      if (style !== undefined) out.style = style;
      return out;
    });
  }

  if (request.request.allowFreeform !== undefined) {
    question.allowFreeform = request.request.allowFreeform;
  }
  if (context !== undefined) question.context = context;

  return question;
}
