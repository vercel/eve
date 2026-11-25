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
import { coalesceQueuedMessages } from "./message-queue.js";
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
import type { StartupOnboardingResult } from "./startup-onboarding.js";
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
  initialDraft?: string;
  signal?: AbortSignal;
};

export type AgentTUIInput =
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "interrupt" };

export type AgentTUIInputContext = {
  position?: { index: number; total: number };
  requester?: string;
  taskId?: string;
};

export type AgentTUIToolApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
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
  initialOptionId?: string;
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
  renderAgentHeader?(header: AgentTUIAgentHeader): void;
  setStartupPhase?(phase: "starting" | "connecting" | "updating" | undefined): void;
  renderNotice?(text: string): void;
  restoreDraft?(text: string): void;
  renderSessionBoundary?(): void;
  renderSetupWarning?(text: string): void;
  clearSetupWarning?(): void;
  renderCommandInvocation?(text: string): void;
  finishCommand?(outcome: CommandPresentation): void;
  choosePromptCommand?(commands: readonly PromptCommandSpec[]): Promise<string | undefined>;
  showInfoPanel?(text: string): Promise<void>;
  readonly setupFlow?: SetupFlowRenderer;
  readonly traceViewer?: TraceViewerRenderer;
  readInput?(options?: AgentTUISessionOptions): Promise<AgentTUIInput | undefined>;
  renderConversation?(view: AgentTUIConversationView): void;
  renderError?(title: string, message: string): void;
  setSessionId?(sessionId: string): void;
  readToolApproval?(
    request: AgentTUIToolApprovalRequest,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIToolApprovalResponse>;
  readInputQuestion?(
    question: AgentTUIInputQuestion,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIInputQuestionResponse | undefined>;
  logDisplayMode?(): LogDisplayMode;
  setLogDisplayMode?(mode: LogDisplayMode): void;
  flushDelayedDevBuildErrors?(): void;
  setVercelStatus?(status: VercelStatusSnapshot): void;
  setRemoteConnectionStatus?(status: RemoteConnectionSnapshot): void;
  reset?(): void;
  shutdown?(): void;
  requestInterrupt?(): void;
  exitRequested?(): boolean;
};

export interface PromptCommandHandlerContext {
  readonly renderer: AgentTUIRenderer;
  readonly title: string;
  readonly initialModelStep?: "provider";
  readonly onOnboardingScreen?: (input: OnboardingScreenEvent) => void;
  readonly chatGptAccountLabel?: string;
  readonly settleOutcome?: (outcome: PromptCommandOutcome) => Promise<PromptCommandOutcome>;
  readonly withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly disabledConnectionReasons?: Readonly<Record<string, string>>;
}

export type CommandPresentation =
  | { kind: "dismiss" }
  | { kind: "result"; message?: string; summary?: string };

export interface PromptCommandOutcome {
  message?: string;
  failed?: true;
  summary?: string;
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
  finish(): { draft: string; queued: readonly string[] };
};

export type EveTUIRunnerOptions = TuiDisplayOptions & {
  probeMcpConnection?: McpConnectionProbe;
  client: Client;
  renderer?: AgentTUIRenderer;
  screen?: TerminalOutput;
  userInput?: TerminalInput;
  formatTransportError?: (error: unknown) => string;
  serverUrl?: string;
  appRoot?: string;
  initialInput?: string;
  signedInRemote?: RemoteDevelopmentTarget;
  onboard?: boolean;
  startupOnboarding?: StartupOnboardingResult;
  onOnboardingStep?: (input: EveCliSetupStepEvent) => void;
  onOnboardingTerminal?: (input: EveCliSetupTerminalEvent) => void;
  promptCommandHandler?: PromptCommandHandler;
  availablePromptCommands?: readonly PromptCommandSpec[];
  argumentSuggestions?: (
    command: ArgumentTypeaheadCommand,
  ) => Promise<readonly PromptArgumentSuggestion[]>;
  withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  remote?: {
    readonly target: RemoteDevelopmentTarget;
    readonly credentials: DevelopmentCredentialGate;
    readonly resolveOidcToken: NonNullable<RemoteConnectionControllerOptions["resolveOidcToken"]>;
    readonly resolveDeployment: NonNullable<RemoteConnectionControllerOptions["resolveDeployment"]>;
    readonly runAuthFlow?: RemoteAuthFlow;
  };
  bootDetections?: readonly BootDetection[];
  detectProjectIdentity?: typeof detectProjectIdentity;
  inspectApplication?: typeof inspectApplication;
  getVercelAuthStatus?: typeof getVercelAuthStatus;
  onBootProgress?: DevBootProgressReporter;
  diagnostics?: DevDiagnostics;
  lifecycle?: CommandLifecycle;
  startup?: TuiStartup;
};

function authIssueForStatus(status: VercelAuthStatus): SetupIssue | undefined {
  if (status === "logged-out") return LOGIN_SETUP_ISSUE;
  if (status === "cli-missing") return CLI_MISSING_SETUP_ISSUE;
  return undefined;
}

function hasOpenTurn(snapshot: SessionStore["snapshot"]): boolean {
  return activeTurn(snapshot.view) !== undefined;
}

export class EveTUIRunner {
  readonly #client: Client;
  readonly #store: SessionStore;
  readonly #renderer: AgentTUIRenderer;
  readonly #diagnostics?: DevDiagnostics;
  readonly #name: string;
  readonly #formatTransportError: (error: unknown) => string;
  readonly #runtimeArtifacts?: DevelopmentRuntimeArtifactRefresher;
  readonly #serverUrl?: string;
  readonly #appRoot?: string;
  readonly #initialInput?: string;
  readonly #startup?: TuiStartup;
  #startupPrompt?: string;
  readonly #onboard: boolean;
  readonly #startupOnboarding: StartupOnboardingResult | undefined;
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
  #disposed = false;
  #sentMessage?: { readonly text: string; deliveryId?: string };
  #cancelRequested = false;
  readonly #authProbeAbort = new AbortController();
  #authHintStale = false;
  #setupAttentionRevision = 0;
  #agentInfoRevision = 0;
  #bootIssues: SetupIssue[] = [];
  #authIssue: SetupIssue | undefined;
  readonly #vercelStatus?: VercelStatusTracker;
  readonly #mcpConnectionStatus?: McpConnectionStatusTracker;
  #agentInfo?: AgentInfoResult;
  #inputController?: AbortController;
  readonly #dismissedInputs = new Set<string>();
  readonly #answeredInputs = new Set<string>();
  readonly #pendingRegistrySetups: string[] = [];
  #activeRegistrySetup?: string;
  readonly #handledHandoffs = new Set<string>();
  #reportedError?: Error;
  #recordedFailures = 0;
  readonly #recordedAgentToolFailures = new Set<string>();
  readonly #callNames = new Map<string, string>();
  readonly #lifecycle?: CommandLifecycle;
  readonly #signedInRemote?: RemoteDevelopmentTarget;

  constructor(options: EveTUIRunnerOptions) {
    this.#client = options.client;
    if (options.signedInRemote !== undefined) this.#signedInRemote = options.signedInRemote;
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
    this.#startupOnboarding = options.startupOnboarding;
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
      const signedIn = this.#signedInRemote;
      if (signedIn !== undefined) {
        this.#renderer.setRemoteConnectionStatus?.({
          connection: { state: "checking" },
          target: signedIn,
        });
      }
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
      if (signedIn !== undefined) {
        this.#renderer.setRemoteConnectionStatus?.({
          connection:
            info === undefined
              ? { failure: { message: "The agent didn't answer." }, state: "unavailable" }
              : { info, state: "ready" },
          target: signedIn,
        });
      }
    }
    this.#reportBeforeFirstPaint();
    const headerInfo = this.#replaceAgentInfo(info);
    if (!this.#onboard) await this.#renderSetupIssues(headerInfo);
  }

  #finishStartup(): string | undefined {
    const startup = this.#startup?.finish();
    this.#startupPrompt = coalesceQueuedMessages(startup?.queued ?? []);
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
      this.#renderer.shutdown?.();
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
    const remote = this.#remoteConnection?.current().connection;
    if (startupOutcome === undefined && remote?.state === "ready" && remote.warning !== undefined) {
      startupOutcome = { message: remote.warning };
    }
    if (initialAgentOnboarding) {
      this.#renderer.setStartupPhase?.("connecting");
      startupOutcome = await this.#runInitialAgentOnboarding(title);
    }
    if (this.#startupOnboarding?.reported === true) await this.#renderSetupIssues(this.#agentInfo);

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

    while (this.#lifecycle?.signal.aborted !== true && this.#renderer.exitRequested?.() !== true) {
      if (this.#sessionFailed()) {
        this.#replaceSession();
        continue;
      }
      if (this.#answerableInputs().length > 0) {
        await this.#answerInputs(title);
        continue;
      }
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
      case "traces":
        await this.#openTraceViewer(command.argument);
        return;
      case "extension":
        await this.#executeExtensionCommand(command, title, { trigger: "command" });
        return;
    }
  }

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

  async #prepareSend(input: SendTurnPayload): Promise<SendTurnPayload> {
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

  #restoreCancelledMessage(conversation: ConversationState): void {
    const sent = this.#sentMessage;
    if (sent?.deliveryId === undefined) return;
    const turnId = delivery(conversation.view, sent.deliveryId)?.turnId;
    if (turnId === undefined) return;
    const turn = readTurn(conversation.view, turnId);
    if (turn === undefined || turn.status === "running") return;
    const status = turn.outcome;
    this.#sentMessage = undefined;
    if (
      status === "cancelled" &&
      !this.#cancelRequested &&
      failure(conversation.view, turnId) === undefined
    )
      this.#renderer.restoreDraft?.(sent.text);
  }

  #reportSessionError(error: Error | undefined, sessionFailed: boolean): void {
    if (error === undefined || error === this.#reportedError) return;
    this.#reportedError = error;
    if (sessionFailed) return;
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

  #answerableInputs(): readonly Interaction[] {
    return openInteractions(this.#store.snapshot.view).filter(
      (input) =>
        input.request.kind !== "sign-in" &&
        !this.#dismissedInputs.has(input.interactionId) &&
        !this.#answeredInputs.has(input.interactionId),
    );
  }

  async #answerInputs(title: string): Promise<void> {
    for (let answered = 0; ; answered += 1) {
      const inputs = this.#answerableInputs();
      const input = inputs[0];
      if (input === undefined) return;
      const context = inputContext(input, answered + 1, answered + inputs.length);
      const response = await this.#readAnswer(input, context, title);
      if (response === undefined) {
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

  #cancelTurn(): void {
    this.#cancelRequested = true;
    void this.#store.cancel().catch((error: unknown) => {
      this.#renderer.renderNotice?.(`Couldn't cancel the turn: ${toErrorMessage(error)}`);
    });
  }

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

  async #resetSession(): Promise<void> {
    try {
      if (this.#store.snapshot.session !== undefined) await (await this.#store.end()).result();
      this.#store.newSession();
    } catch (error) {
      this.#finishCommand({
        kind: "result",
        message: `Couldn't end the session: ${toErrorMessage(error)}`,
      });
      return;
    }
    this.#clearRunnerState();
    this.#renderer.reset?.();
    this.#finishCommand({ kind: "dismiss" });
  }

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
    this.#probeAuthIssue();
  }

  #paintSetupAttention(): void {
    if (this.#startupActive) return;
    const issues = orderedSetupIssues(this.#bootIssues, this.#authIssue);
    if (issues.length > 0) {
      this.#renderer.renderSetupWarning?.(formatSetupIssuesLine(issues));
    } else {
      this.#renderer.clearSetupWarning?.();
    }
  }

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
    let outcome: PromptCommandOutcome | undefined;
    if (this.#startupOnboarding === undefined) {
      this.#onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
      outcome = await this.#executeExtensionCommand(
        { type: "extension", name: "login", argument: "" },
        title,
        { trigger: "startup", initialModelStep: "provider" },
      );
    } else if (this.#startupOnboarding.reported === true) {
      return undefined;
    } else {
      const pending = this.#startupOnboarding.outcome;
      outcome = pending && (await this.#settleCommandOutcome(pending));
    }
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

function registryHandoffs(
  conversation: ConversationState,
): Array<{ readonly callId: string; readonly address: string }> {
  const handoffs: Array<{ callId: string; address: string }> = [];
  const collect = (state: ConversationState, subagentName: string) => {
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (!isTerminalToolCallPart(part) || part.state !== "completed") continue;
        const address = registryHandoffAddress(subagentName, part.name, part.output);
        if (address !== undefined) handoffs.push({ callId: part.callId, address });
      }
    }
  };
  for (const agent of Object.values(conversation.agents)) {
    if (agent.observation.status === "not-followed") continue;
    const child = agent.observation.conversation;
    if (child !== undefined) collect(child, agent.name);
  }
  return handoffs;
}

export function registryHandoffAddress(
  subagentName: string,
  toolName: string | undefined,
  output: unknown,
): string | undefined {
  const isPackagedChild =
    subagentName === "self-modification__agent" && toolName === "registry_add";
  if (!isPackagedChild || typeof output !== "object" || output === null) {
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

  if (request.request.display === "select" && request.request.initialOptionId !== undefined) {
    question.initialOptionId = request.request.initialOptionId;
  }
  if (request.request.allowFreeform !== undefined) {
    question.allowFreeform = request.request.allowFreeform;
  }
  if (context !== undefined) question.context = context;

  return question;
}
