import { StringDecoder } from "node:string_decoder";
import type { DevDiagnostics } from "../diagnostics.js";

import type {
  AgentTUIInput,
  AgentTUIInputContext,
  AgentTUIInputOption,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIRenderer,
  AgentTUISessionOptions,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
  CommandPresentation,
} from "./runner.js";
import type { AgentTUIConversationView, TokenUsage } from "./conversation-view.js";
import { ConversationTranscript, turnActivity, type TranscriptOptions } from "./transcript.js";
import { renderTaskPanelRows } from "./task-activity.js";
import { interruptedError } from "./errors.js";
import {
  argumentTypeaheadCompletion,
  argumentTypeaheadFor,
  argumentTypeaheadLoadingLabel,
  argumentTypeaheadQuery,
  moveArgumentTypeaheadSelection,
  renderArgumentSuggestions,
  selectedArgumentSuggestion,
  type ArgumentTypeaheadState,
  type PromptArgumentSuggestion,
} from "./argument-typeahead.js";
import {
  dismissTypeahead,
  inlineCommandHint,
  isTypeaheadOpen,
  moveTypeaheadSelection,
  renderCommandSuggestions,
  selectedTypeaheadCommand,
  typeaheadCompletion,
  typeaheadFor,
  type CommandTypeaheadState,
} from "./command-typeahead.js";
import {
  isPromptControlCommand,
  parsePromptCommand,
  promptCommandSpec,
  PROMPT_COMMANDS,
  type ArgumentTypeaheadCommand,
  type PromptCommandSpec,
} from "./prompt-commands.js";
import {
  enterBadge,
  flowMessageRows,
  renderAcknowledgeQuestion,
  renderSelectQuestion,
  renderTextQuestion,
  type FlowPanelContent,
  type FlowPanelIndicator,
  type FlowPanelLine,
  type FlowPanelStatus,
  type SetupPanelOption,
  type SetupSelectPanelState,
} from "./setup-panel.js";
import { renderFlowDrawer, renderTransientDrawer } from "./flow-drawer.js";
import type {
  SetupEditableSelectResult,
  SetupFlowInterrupt,
  SetupFlowRenderer,
  SetupSelectRequest,
  SetupSelectResult,
} from "./setup-flow.js";
import type { PlannerNavigation, SelectNotice } from "#setup/prompter.js";
import type { ProviderPickerChoice, ProviderPickerRequest } from "#setup/flows/provider.js";
import {
  initialSelectState,
  orderedSelection,
  reduceSelect,
  searchActionQuery,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
} from "./types.js";
import type { AgentInfoResult } from "#client/index.js";
import { initialPromptPlaceholder } from "./prompt-placeholder.js";
import type { LogRecord } from "#internal/logging.js";
import {
  parseDevRebuildLogLine,
  type DevRebuildLogUpdate,
} from "#internal/nitro/host/dev-watcher-log.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  type Block,
  type DisplayBlock,
  type BlockKind,
  renderAttentionRows,
  renderBlockLines,
} from "./blocks.js";
import { formatDevRebuildStatus, summarizeChangedFiles } from "./dev-rebuild-status.js";
import {
  initialProviderPickerState,
  transitionProviderPicker,
  type ProviderPickerEvent,
} from "./provider-picker.js";
import { buildAgentHeader } from "./agent-header.js";
import { detectMarkdownRendering } from "./markdown.js";
import {
  EMPTY_LINE,
  KillRing,
  PromptHistory,
  applyLineEditorKey,
  deleteForward,
  layoutPromptInput,
  lineOf,
  movePromptLine,
  visibleLine,
  type LineState,
} from "./line-editor.js";
import { LiveRegion } from "#cli/ui/live-region.js";
import { AltScreen } from "#cli/ui/alt-screen.js";
import { copyTextToClipboard } from "./clipboard.js";
import type { TraceViewerOpenOptions, TraceViewerRenderer } from "./traces/trace-viewer-session.js";
import { TraceViewerSession } from "./traces/trace-viewer-session.js";
import { buildStatusLine, type DevBuildStatus } from "./status-line.js";
import { isLogVisible, nextLogDisplayMode } from "./log-display-mode.js";
import { setConsoleRecordSubscriber, type ConsoleRecord } from "../console-records.js";
import type { LogLevel } from "#internal/logging.js";
import { format } from "node:util";
import { createTheme, detectUnicode, type Theme } from "./theme.js";
import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  stripAnsi,
  wrapVisibleLine,
  stripTerminalControls,
} from "#cli/ui/terminal-text.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import { groupToolBlocksForDisplay } from "./tool-block-groups.js";
import {
  fitQuestionPanel,
  inputContextLabel,
  renderQuestionPanel,
  renderQuestionPrompt,
} from "./question-panel.js";
import { TurnClock } from "./turn-clock.js";
import { MessageQueue, renderMessageQueueRows } from "./message-queue.js";
import { formatStoredDiagnostic, presentDiagnostic } from "./diagnostic-presentation.js";
import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";
import {
  isProgressPulseVisible,
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_GLYPH,
} from "#cli/ui/progress-pulse.js";
import { eveVersionTag } from "#cli/banner.js";
import { readGatewayServiceTier } from "#shared/gateway-service-tier.js";
import {
  formatAssistantResponseStats,
  formatTokenFlow,
  formatTurnDuration,
  isIncompleteOsc,
  isIncompletePaste,
  nextKey,
  sanitizePastedText,
  stripPasteStart,
  stripPromptControlCharacters,
  type TerminalKey,
} from "./stream-format.js";
import {
  BACKGROUND_COLOR_QUERY,
  parseBackgroundColorReply,
  type RgbColor,
} from "./terminal-background.js";

type SetupOptionPanelState = Exclude<SetupSelectPanelState, { kind: "actions" }>;

const ARGUMENT_CATALOG_LOADING_DELAY_MS = 500;

export type TerminalInput = {
  isTTY?: boolean;
  on(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  off(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  resume(): TerminalInput;
  pause(): TerminalInput;
  setRawMode?: (mode: boolean) => TerminalInput;
};

export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
  on(event: "resize", listener: () => void): TerminalOutput;
  off(event: "resize", listener: () => void): TerminalOutput;
};

function isMultiSelectRequest(
  options: SetupSelectRequest,
): options is Extract<SetupSelectRequest, { kind: "multi" | "searchable-multi" }> {
  return options.kind === "multi" || options.kind === "searchable-multi";
}

function moveActionCursor(
  cursor: number | undefined,
  direction: "up" | "down",
  actionCount: number,
): number | undefined {
  if (actionCount === 0) return undefined;
  if (cursor === undefined) return direction === "down" ? 0 : actionCount - 1;
  const delta = direction === "down" ? 1 : -1;
  return (cursor + delta + actionCount) % actionCount;
}

type SetupFlowStatusState = { text: string; startedAtMs: number };

type SetupFlowState = {
  title: string;
  navigation?: PlannerNavigation;
  startedAtMs: number;
  lines: FlowPanelLine[];
  summary?: { headline: string; facts: readonly { label: string; value: string }[] };
  status?: SetupFlowStatusState;
  preview?: string;
  outputBuffer: string[];
  question?: (width: number) => string[];
  questionTitle?: string;
  taskListLineStart?: number;
  hideLinesWhileQuestion?: boolean;
  implicit?: boolean;
};

const FLOW_OUTPUT_BUFFER_CAP = 40;
const STATUS_LINE_LEFT_PADDING = "  ";

const defaultAssistantResponseStats: AssistantResponseStatsMode = "tokensPerSecond";

type TerminalRendererOptions = {
  input?: TerminalInput;
  output?: TerminalOutput;
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  subagents?: SubagentDisplayMode;
  connectionAuth?: TerminalPartDisplayMode;
  assistantResponseStats?: AssistantResponseStatsMode;
  contextSize?: number;
  captureForeignOutput?: boolean;
  logs?: LogDisplayMode;
  color?: boolean;
  unicode?: boolean;
  renderMarkdown?: boolean;
  diagnostics?: DevDiagnostics;
  availablePromptCommands?: readonly PromptCommandSpec[];
  argumentSuggestions?: (
    command: ArgumentTypeaheadCommand,
  ) => Promise<readonly PromptArgumentSuggestion[]>;
  onExitRequest?: () => void;
};

type AgentHeaderOptions = {
  name: string;
  serverUrl: string;
  info?: AgentInfoResult;
  localDevelopment?: boolean;
};

const caretBlinkMs = 500;
const tickMs = 90;
const hitlDrawerChromeRows = 5;
const escFlushMs = 30;
const incompletePasteFlushMs = 1_000;
const logLevelHintMs = 5_000;
const devBuildProgressDelayMs = 250;
const devBuildLoadedStatusMs = 4_000;

const turnStatsMinDurationMs = 10_000;
const turnStatsMinInputTokens = 20_000;

export class TerminalRenderer implements AgentTUIRenderer {
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;
  readonly #live: LiveRegion;
  readonly #altScreen: AltScreen;
  readonly #theme: Theme;
  readonly #renderMarkdown: boolean;
  readonly #tools: TerminalPartDisplayMode;
  readonly #reasoning: TerminalPartDisplayMode;
  readonly #subagents: SubagentDisplayMode;
  readonly #connectionAuth: TerminalPartDisplayMode;
  readonly #assistantResponseStats: AssistantResponseStatsMode;
  readonly #captureForeignOutput: boolean;
  readonly #diagnostics?: DevDiagnostics;
  readonly #availablePromptCommands: readonly PromptCommandSpec[];
  #logs: LogDisplayMode;

  #blocks: Block[] = [];
  readonly #blockById = new Map<string, Block>();
  #pendingCommandEcho: Block | undefined;
  readonly #committedIds = new Set<string>();
  readonly #transcriptBlocks: Block[] = [];

  #updateSequence = 0;
  readonly #transcript = new ConversationTranscript();
  #view?: AgentTUIConversationView;
  #conversationBlockIds = new Set<string>();
  readonly #steeredMessages: string[] = [];
  #agentHeader?: AgentHeaderOptions;
  #initialPromptPlaceholder = "Send a message…";
  #subagentNames?: readonly string[];
  #startupPhase?: "installing" | "starting" | "connecting" | "updating";
  #startupEditor?: LineState;
  #startupConsumer?: (key: TerminalKey) => void;
  #startupStartedAt = 0;
  #startupHeader?: { readonly name: string };
  #agentHeaderRendered = false;
  #agentHeaderBody?: string;
  readonly #committedTranscriptRows: string[] = [];

  #lastCommitted?: PreviousBlock;

  #vercelStatus?: VercelStatusSnapshot;
  #remoteConnection?: RemoteConnectionSnapshot;
  #inputText = "";
  #inputCursor = 0;
  readonly #promptHistory = new PromptHistory();
  readonly #killRing = new KillRing();
  #inputActive = false;
  #typeahead?: CommandTypeaheadState;
  #argumentTypeahead?: ArgumentTypeaheadState;
  readonly #argumentSuggestions?: TerminalRendererOptions["argumentSuggestions"];
  readonly #argumentCatalogs = new Map<
    ArgumentTypeaheadState["command"],
    | { kind: "loading"; visible: boolean }
    | { kind: "ready"; suggestions: readonly PromptArgumentSuggestion[] }
  >();
  readonly #argumentCatalogLoadingTimers = new Map<
    ArgumentTypeaheadState["command"],
    ReturnType<typeof setTimeout>
  >();
  #promptPlaceholderActive = false;
  #hasUserMessage = false;
  readonly #turnClock = new TurnClock();
  #lastTurnStats?: { elapsedMs: number } & TokenUsage;
  #draft: LineState = EMPTY_LINE;
  #applyDraft?: (next: LineState) => void;
  #cancelRequested = false;
  #rejectActiveReader?: (error: Error) => void;
  #flowlessStatus?: string;
  #title = "eve";
  #isInteractive = false;
  #everInteractive = false;
  #partingLinePrinted = false;
  #handingOff = false;
  #frameKept = false;
  #startupPreamble: readonly string[] = [];
  #pendingCommittedRows: string[] = [];
  #composerPending = false;
  #paintDeferred = false;
  #exitRequested = false;
  #exitArmed = false;
  #armExitOnNextPrompt = false;
  readonly #onExitRequest?: () => void;
  #caretVisible = true;
  #spinnerIndex = 0;
  #activityPulseStartedAtMs = Date.now();
  #caretTimer?: ReturnType<typeof setInterval>;
  #tickTimer?: ReturnType<typeof setInterval>;
  #logLevelHintTimer?: ReturnType<typeof setTimeout>;
  #logLevelHintActive = false;
  #consumeKey?: (key: TerminalKey) => void;
  #keyBuffer = "";
  #inputDecoder = new StringDecoder("utf8");
  #keyFlushTimer?: ReturnType<typeof setTimeout>;
  #onResize?: () => void;
  #painting = false;
  #paintAgain = false;
  #contextSize?: number;

  #restoreLogCapture?: () => void;
  #stdoutLogBuffer = "";
  #stderrLogBuffer = "";
  #delayedDevBuildError?: string;
  #devRebuild?: { id: string; summary: string };
  #devBuildStatus?: DevBuildStatus;
  #devBuildStatusVisible = false;
  #devBuildStatusTimer?: ReturnType<typeof setTimeout>;
  #devRebuildSequence = 0;
  #hitlDrawer?: (width: number) => ReturnType<typeof renderTransientDrawer>;
  #transientPanel?: (width: number) => ReturnType<typeof renderTransientDrawer>;
  #transientPanelClose?: () => void;
  #setupFlow?: SetupFlowState;
  #setupAttention?: string;
  readonly #startupQueue = new MessageQueue();
  #sessionId?: string;
  #flowInterrupt?: (interrupt: SetupFlowInterrupt) => void;
  #flowIdleConsumer?: (key: TerminalKey) => void;
  #traceView?: TraceViewerSession;
  #terminalBackground?: RgbColor;
  readonly setupFlow: SetupFlowRenderer = {
    begin: (title) => this.#beginSetupFlow(title),
    setNavigation: (navigation) => this.#setSetupFlowNavigation(navigation),
    end: (options) => this.#endSetupFlow(options?.preserveDiagnostics ?? true),
    readSelect: (options) => this.#readSetupSelect(options),
    readEditableSelect: (options) => this.#readSetupEditableSelect(options),
    readProviderPicker: (options) => this.#readProviderPicker(options),
    readText: (options) => this.#readSetupText(options),
    readAcknowledge: (options) => this.#readSetupAcknowledge(options),
    readChoice: (options) => this.#readSetupChoice(options),
    setStatus: (text) => this.#setFlowStatus(text),
    renderLine: (text, tone) => this.#renderFlowLine(text, tone),
    replaceContent: (content) => this.#replaceFlowContent(content),
    renderOutput: (text) => this.#renderFlowOutput(text),
    withInheritedStdio: (task) => this.#withInheritedStdio(task),
    withExclusiveTerminal: (task) => this.#withInheritedStdio(task),
    waitForInterrupt: (options) => this.#waitForFlowInterrupt(options),
  };

  readonly traceViewer: TraceViewerRenderer = {
    open: (options) => this.#openTraceViewer(options),
  };

  constructor(options?: TerminalRendererOptions) {
    this.#input = options?.input ?? process.stdin;
    this.#output = options?.output ?? process.stdout;
    this.#live = new LiveRegion(this.#output);
    this.#altScreen = new AltScreen(this.#output);
    this.#theme = createTheme({
      color: options?.color ?? true,
      unicode: options?.unicode ?? detectUnicode(),
    });
    this.#renderMarkdown = options?.renderMarkdown ?? detectMarkdownRendering();
    this.#tools = options?.tools ?? "auto-collapsed";
    this.#reasoning = options?.reasoning ?? "auto-collapsed";
    this.#subagents = options?.subagents ?? "collapsed";
    this.#connectionAuth = options?.connectionAuth ?? "full";
    this.#assistantResponseStats = options?.assistantResponseStats ?? defaultAssistantResponseStats;
    this.#contextSize = options?.contextSize;
    this.#captureForeignOutput = options?.captureForeignOutput ?? this.#output === process.stdout;
    this.#diagnostics = options?.diagnostics;
    this.#onExitRequest = options?.onExitRequest;
    this.#argumentSuggestions = options?.argumentSuggestions;
    this.#logs = options?.logs ?? "error";
    this.#availablePromptCommands = options?.availablePromptCommands ?? PROMPT_COMMANDS;
  }

  #syncTypeahead(text: string): void {
    this.#typeahead = typeaheadFor(this.#availablePromptCommands, text, this.#typeahead);
    const query = argumentTypeaheadQuery(text);
    if (query === undefined || this.#argumentSuggestions === undefined) {
      this.#argumentTypeahead = undefined;
      return;
    }
    const catalog = this.#argumentCatalogs.get(query.command);
    if (catalog === undefined) {
      this.#argumentCatalogs.set(query.command, { kind: "loading", visible: false });
      const command = query.command;
      this.#argumentCatalogLoadingTimers.set(
        command,
        setTimeout(() => {
          this.#argumentCatalogLoadingTimers.delete(command);
          const pending = this.#argumentCatalogs.get(command);
          if (pending?.kind !== "loading") return;
          this.#argumentCatalogs.set(command, { kind: "loading", visible: true });
          this.#paint();
        }, ARGUMENT_CATALOG_LOADING_DELAY_MS),
      );
      void this.#argumentSuggestions(command)
        .catch(() => [])
        .then((suggestions) => {
          const timer = this.#argumentCatalogLoadingTimers.get(command);
          if (timer !== undefined) clearTimeout(timer);
          this.#argumentCatalogLoadingTimers.delete(command);
          this.#argumentCatalogs.set(command, { kind: "ready", suggestions });
          if (this.#inputActive) this.#syncTypeahead(this.#inputText);
          this.#paint();
        });
      this.#argumentTypeahead = undefined;
      return;
    }
    if (catalog.kind === "loading") {
      this.#argumentTypeahead = undefined;
      return;
    }
    this.#argumentTypeahead = argumentTypeaheadFor(
      query,
      catalog.suggestions,
      this.#argumentTypeahead,
    );
  }

  #typeaheadDrawerRows(width: number): string[] {
    const query = argumentTypeaheadQuery(this.#inputText);
    const catalog = query === undefined ? undefined : this.#argumentCatalogs.get(query.command);
    if (catalog?.kind === "loading" && catalog.visible && query !== undefined) {
      return [
        clip(
          this.#theme.colors.dim(`Loading ${argumentTypeaheadLoadingLabel(query.command)}…`),
          width,
        ),
      ];
    }
    if (this.#argumentTypeahead !== undefined) {
      return renderArgumentSuggestions(this.#argumentTypeahead, this.#theme, width);
    }
    return this.#typeahead !== undefined && isTypeaheadOpen(this.#typeahead)
      ? renderCommandSuggestions(this.#typeahead, this.#theme, width)
      : [];
  }

  setStartupPhase(phase: "installing" | "starting" | "connecting" | "updating" | undefined): void {
    this.#startupPhase = phase;
    if (phase === undefined) this.#stopTicker();
    else this.#startTicker();
    this.#paint();
  }

  renderAgentHeader(options: AgentHeaderOptions): void {
    this.#startupHeader = undefined;
    this.#title = options.name;
    this.#agentHeader = options;
    this.#subagentNames = options.info?.subagents.local.map((subagent) => subagent.name);
    this.#initialPromptPlaceholder = initialPromptPlaceholder(
      options.info,
      options.localDevelopment === true,
    );
    this.#start();
    const body = this.#renderAgentHeaderRows().join("\n");
    if (this.#agentHeaderRendered) {
      if (body !== this.#agentHeaderBody) {
        this.#agentHeaderBody = body;
        this.#pushBlock({ kind: "agent-header", body, live: false });
      }
      this.#paint();
      return;
    }

    this.#agentHeaderRendered = true;
    this.#agentHeaderBody = body;
    this.#pendingCommittedRows.push(...this.#renderAgentHeaderRows());
    this.#paint();
  }

  beginStartupDraft(options: {
    initialDraft?: string;
    queued?: readonly string[];
    title: string;
    phase?: "installing" | "starting";
    preamble?: readonly string[];
  }): void {
    for (const message of options.queued ?? []) this.#startupQueue.enqueue(message);
    this.#start({ title: options.title });
    this.#inputActive = true;
    this.#promptPlaceholderActive = true;
    this.#startupPhase = options.phase ?? "starting";
    this.#startupPreamble = options.preamble ?? [];
    this.#startupHeader = { name: options.title };
    this.#startupStartedAt = Date.now();
    let editor = lineOf(stripPromptControlCharacters(options.initialDraft ?? ""));
    this.#startupEditor = editor;
    this.#syncInput(editor);
    this.#startCaretBlink();
    this.#startTicker();
    this.#paint();

    const apply = (next: LineState) => {
      editor = next;
      this.#startupEditor = next;
      this.#showCaret();
      this.#syncInput(editor);
      this.#paint();
    };
    this.#startupConsumer = (key) => {
      if (key.type === "escape" && this.#flowInterrupt !== undefined) {
        this.#flowInterrupt("escape");
        return;
      }
      if (key.type === "ctrl-c" && this.#flowInterrupt !== undefined) {
        this.#requestExit();
        this.#flowInterrupt("ctrl-c");
        return;
      }
      const edited = this.#killRing.apply(editor, key, { multiline: true });
      if (edited !== undefined) {
        apply(edited);
        return;
      }
      if (key.type === "enter" && editor.text.trim().length > 0) {
        if (this.#startupQueue.enqueue(editor.text)) apply(EMPTY_LINE);
        return;
      }
      if (key.type === "ctrl-c") this.#onExitRequest?.();
    };
    this.#resumeStartupDraft();
  }

  #resumeStartupDraft(): void {
    if (this.#startupEditor === undefined || this.#startupConsumer === undefined) return;
    this.#clearKeyFlush();
    this.#syncInput(this.#startupEditor);
    this.#inputActive = true;
    this.#consumeKey = this.#startupConsumer;
    this.#attachInput();
  }

  finishStartupDraft(): { draft: string; queued: readonly string[] } {
    const result = {
      draft: this.#startupEditor?.text ?? this.#inputText,
      queued: this.#startupQueue.take(),
    };
    this.#startupEditor = undefined;
    this.#startupConsumer = undefined;
    this.#detachInput();
    this.#stopCaretBlink();
    this.#inputActive = false;
    this.#promptPlaceholderActive = false;
    if (this.#isInteractive) {
      this.#composerPending = true;
      queueMicrotask(() => this.#releaseComposerHold());
    }
    return result;
  }

  #releaseComposerHold(): void {
    if (!this.#composerPending) return;
    this.#composerPending = false;
    if (!this.#paintDeferred) return;
    this.#paintDeferred = false;
    this.#paint();
  }

  async readInput(options?: AgentTUISessionOptions): Promise<AgentTUIInput | undefined> {
    this.#composerPending = false;
    this.#paintDeferred = false;
    this.#start(options);
    if (this.#view?.working !== true) this.#commitTurnStats();
    this.#inputActive = true;
    this.#promptPlaceholderActive = true;
    this.#exitArmed = this.#armExitOnNextPrompt;
    this.#armExitOnNextPrompt = false;
    let editor: LineState =
      options?.initialDraft === undefined
        ? this.#draft
        : lineOf(stripPromptControlCharacters(options.initialDraft));
    this.#promptHistory.begin(editor.text);
    this.#syncInput(editor);
    this.#syncTypeahead(editor.text);
    this.#startCaretBlink();
    this.#paint();

    return await new Promise((resolve, reject) => {
      const signal = options?.signal;
      const release = () => {
        this.#applyDraft = undefined;
        signal?.removeEventListener("abort", onAbort);
        this.#typeahead = undefined;
        this.#argumentTypeahead = undefined;
        this.#inputActive = false;
        this.#stopCaretBlink();
        this.#detachInput();
        this.#paint();
      };
      const finish = (input: AgentTUIInput | undefined) => {
        release();
        resolve(input);
      };
      const onAbort = () => finish(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.#rejectActiveReader = (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const apply = (next: LineState) => {
        editor = next;
        this.#draft = next;
        this.#showCaret();
        this.#syncInput(editor);
        this.#syncTypeahead(next.text);
        this.#paint();
      };
      this.#applyDraft = apply;
      const recall = (entry: string | undefined) => {
        if (entry !== undefined) apply(lineOf(entry));
      };
      const interrupt = () => {
        this.#typeahead = undefined;
        this.#stopCaretBlink();
        this.#stop();
        reject(interruptedError());
      };
      const cancel = () => {
        this.#cancelRequested = true;
        finish({ type: "cancel" });
      };
      const suggestions = () =>
        this.#typeahead !== undefined && isTypeaheadOpen(this.#typeahead)
          ? this.#typeahead
          : undefined;
      const argumentSuggestions = () =>
        this.#argumentTypeahead?.suggestions.length ? this.#argumentTypeahead : undefined;
      const highlighted = () => {
        const open = suggestions();
        return open === undefined ? undefined : selectedTypeaheadCommand(open);
      };

      this.#consumeKey = (key) => {
        if (key.type !== "ctrl-c" && this.#exitArmed) {
          this.#exitArmed = false;
          this.#paint();
        }
        const edited = this.#killRing.apply(editor, key, { multiline: true });
        if (edited !== undefined) {
          apply(edited);
          return;
        }
        const working = this.#view?.working === true;
        switch (key.type) {
          case "up":
          case "ctrl-p": {
            const argumentOpen = argumentSuggestions();
            if (argumentOpen !== undefined) {
              this.#argumentTypeahead = moveArgumentTypeaheadSelection(argumentOpen, -1);
              this.#paint();
              break;
            }
            const open = suggestions();
            if (open !== undefined) {
              this.#typeahead = moveTypeaheadSelection(open, -1);
              this.#paint();
              break;
            }
            const moved = movePromptLine(editor, "up");
            if (moved !== undefined) apply(moved);
            else recall(this.#promptHistory.previous(editor.text));
            break;
          }
          case "down":
          case "ctrl-n": {
            const argumentOpen = argumentSuggestions();
            if (argumentOpen !== undefined) {
              this.#argumentTypeahead = moveArgumentTypeaheadSelection(argumentOpen, 1);
              this.#paint();
              break;
            }
            const open = suggestions();
            if (open !== undefined) {
              this.#typeahead = moveTypeaheadSelection(open, 1);
              this.#paint();
              break;
            }
            const moved = movePromptLine(editor, "down");
            if (moved !== undefined) apply(moved);
            else recall(this.#promptHistory.next());
            break;
          }
          case "tab": {
            const argumentOpen = argumentSuggestions();
            const argumentSelected =
              argumentOpen === undefined ? undefined : selectedArgumentSuggestion(argumentOpen);
            if (argumentOpen !== undefined && argumentSelected !== undefined) {
              apply(lineOf(argumentTypeaheadCompletion(argumentOpen, argumentSelected)));
              break;
            }
            const selected = highlighted();
            if (selected !== undefined) apply(lineOf(typeaheadCompletion(selected)));
            break;
          }
          case "escape": {
            if (this.#argumentTypeahead !== undefined) {
              this.#argumentTypeahead = undefined;
              this.#paint();
              break;
            }
            const open = suggestions();
            if (open !== undefined) {
              this.#typeahead = dismissTypeahead(open);
              this.#paint();
              break;
            }
            if (working && !this.#cancelRequested) cancel();
            break;
          }
          case "enter": {
            const argumentOpen = argumentSuggestions();
            const argumentSelected =
              argumentOpen === undefined ? undefined : selectedArgumentSuggestion(argumentOpen);
            const selected = highlighted();
            if (
              argumentOpen !== undefined &&
              argumentSelected?.next !== undefined &&
              argumentOpen.completed.length === 0
            ) {
              apply(lineOf(`${argumentTypeaheadCompletion(argumentOpen, argumentSelected)} `));
              break;
            }
            if (
              argumentOpen === undefined &&
              selected !== undefined &&
              this.#argumentSuggestions !== undefined &&
              (selected.name === "add" ||
                selected.name === "login" ||
                selected.name === "loglevel" ||
                selected.name === "model")
            ) {
              apply(lineOf(typeaheadCompletion(selected)));
              break;
            }
            const prompt =
              argumentOpen !== undefined && argumentSelected !== undefined
                ? argumentTypeaheadCompletion(argumentOpen, argumentSelected)
                : selected !== undefined && parsePromptCommand(editor.text) === null
                  ? typeaheadCompletion(selected).trimEnd()
                  : editor.text;
            if (prompt.trim().length === 0) break;
            if (promptCommandSpec(prompt)?.spec.history !== "omit") this.#promptHistory.add(prompt);
            this.#draft = EMPTY_LINE;
            this.#syncInput(EMPTY_LINE);
            if (isPromptControlCommand(prompt)) {
              this.#pushCommandEcho(stripTerminalControls(prompt.trim()));
              if (working && parsePromptCommand(prompt)?.type === "cancel") {
                this.#cancelRequested = true;
              }
            } else {
              this.#hasUserMessage = true;
              this.#diagnostics?.recordPrompt();
              if (working) this.#steeredMessages.push(prompt);
            }
            finish({ type: "submit", text: prompt });
            break;
          }
          case "ctrl-d":
            if (editor.text.length === 0) {
              this.#requestExit();
              interrupt();
            } else {
              apply(deleteForward(editor));
            }
            break;
          case "ctrl-l":
            this.#cycleLogDisplayMode();
            break;
          case "ctrl-r":
            this.#paint();
            break;
          case "ctrl-c":
            if (working) {
              if (!this.#cancelRequested) {
                cancel();
                break;
              }
              this.#cancelRequested = false;
              this.#armExitOnNextPrompt = true;
              finish({ type: "interrupt" });
              break;
            }
            if (this.#exitArmed) {
              this.#requestExit();
              interrupt();
              break;
            }
            this.#exitArmed = true;
            apply(EMPTY_LINE);
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  renderConversation(view: AgentTUIConversationView): void {
    const wasWorking = this.#view?.working === true;
    this.#view = view;
    if (view.conversation.messages.some((message) => message.role === "user")) {
      this.#hasUserMessage = true;
    }
    const projected = this.#transcript.project(view, this.#transcriptOptions());
    const ids = new Set<string>();
    for (const [index, block] of projected.entries()) {
      const id = block.id!;
      if (this.#committedIds.has(id)) continue;
      ids.add(id);
      const existing = this.#blockById.get(id);
      if (existing === block) continue;
      block.updateSeq = ++this.#updateSequence;
      if (existing !== undefined) {
        this.#blocks[this.#blocks.indexOf(existing)] = block;
        this.#blockById.set(id, block);
        continue;
      }
      if (block.kind === "user") {
        const steered = this.#steeredMessages.indexOf(block.body ?? "");
        if (steered !== -1) {
          this.#steeredMessages.splice(steered, 1);
          block.promptOrigin = "steer";
        }
      }
      this.#insertConversationBlock(block, projected.slice(index + 1));
    }
    for (const id of this.#conversationBlockIds) {
      if (!ids.has(id)) this.#removeBlock(id);
    }
    this.#conversationBlockIds = ids;
    if (view.working && !wasWorking) {
      if (!this.#turnClock.armed) this.#turnClock.arm(view.data.usage);
    } else if (!view.working && wasWorking) {
      this.#cancelRequested = false;
      if (this.#inputActive) this.#commitTurnStats();
    }
    this.#syncActivityTicker();
    this.#paint();
  }

  #insertConversationBlock(block: Block, following: readonly Block[]): void {
    const next = following.find((candidate) => this.#blockById.has(candidate.id!));
    const index = next === undefined ? -1 : this.#blocks.indexOf(this.#blockById.get(next.id!)!);
    if (index === -1) {
      this.#pushBlock(block);
      return;
    }
    if (block.id !== this.#devRebuild?.id) this.#settleDevRebuildStatus();
    this.#blocks.splice(index, 0, block);
    this.#blockById.set(block.id!, block);
  }

  #transcriptOptions(): TranscriptOptions {
    return {
      tools: this.#tools,
      reasoning: this.#reasoning,
      subagents: this.#subagents,
      connectionAuth: this.#connectionAuth,
      subagentNames: this.#subagentNames,
      diagnosticsPath: this.#diagnostics?.displayPath,
      dot: this.#theme.glyph.dot,
    };
  }

  #inputContextLabel(context: AgentTUIInputContext | undefined): string | undefined {
    if (
      context?.taskId === undefined ||
      context.requester !== undefined ||
      this.#view === undefined
    ) {
      return inputContextLabel(context, this.#theme);
    }
    const requester = this.#transcript.taskLabel(this.#view.conversation, context.taskId);
    return inputContextLabel(
      requester === undefined ? context : { ...context, requester },
      this.#theme,
    );
  }

  #syncInput(state: LineState): void {
    this.#inputText = state.text;
    this.#inputCursor = state.cursor;
  }

  async readToolApproval(
    request: AgentTUIToolApprovalRequest,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIToolApprovalResponse> {
    this.#start(options);
    this.#inputActive = false;
    let approvalCursor = 0;
    this.#hitlDrawer = (width) =>
      renderTransientDrawer(
        renderQuestionPanel(
          {
            prompt: request.prompt,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
            cursor: approvalCursor,
            allowFreeform: false,
            editor: EMPTY_LINE,
            caretVisible: false,
            maxRows: this.#height() - hitlDrawerChromeRows,
          },
          this.#theme,
          width,
        ),
        ["y yes · n no · Ctrl-C cancel"],
        this.#theme,
        width,
        this.#inputContextLabel(request.context),
        false,
        "left",
      );
    this.#paint();

    return await new Promise((resolve, reject) => {
      const approve = () => {
        this.#hitlDrawer = undefined;
        this.#detachInput();
        this.#paint();
        resolve({ approved: true });
      };
      const deny = () => {
        this.#hitlDrawer = undefined;
        this.#detachInput();
        this.#paint();
        resolve({ approved: false, reason: "Denied by user." });
      };
      this.#rejectActiveReader = reject;
      this.#consumeKey = (key) => {
        switch (key.type) {
          case "text": {
            if (key.framing !== "unframed") break;
            const value = key.value.toLowerCase();
            if (value === "y") approve();
            else if (value === "n") deny();
            break;
          }
          case "up":
          case "ctrl-p":
            approvalCursor = 0;
            this.#paint();
            break;
          case "down":
          case "ctrl-n":
            approvalCursor = 1;
            this.#paint();
            break;
          case "enter":
            if (approvalCursor === 0) approve();
            else deny();
            break;
          case "ctrl-r":
            this.#paint();
            break;
          case "ctrl-c":
            this.#hitlDrawer = undefined;
            this.#stop();
            reject(interruptedError());
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  async readInputQuestion(
    question: AgentTUIInputQuestion,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIInputQuestionResponse | undefined> {
    this.#start(options);
    this.#inputActive = false;
    this.#promptPlaceholderActive = false;

    const optionList = question.options ?? [];
    const hasOptions = optionList.length > 0;
    const allowFreeform = question.allowFreeform === true || !hasOptions;
    const hasFreeformRow = allowFreeform && hasOptions;
    const totalRows = optionList.length + (hasFreeformRow ? 1 : 0);
    const sectionKey = questionSectionId(question.requestId);

    let mode: "select" | "text" = hasOptions ? "select" : "text";
    let cursorIndex = Math.max(
      0,
      optionList.findIndex((option) => option.id === question.initialOptionId),
    );
    let editor = EMPTY_LINE;

    const isOnFreeformRow = () => hasFreeformRow && cursorIndex === optionList.length;

    const selectDrawer = (width: number) =>
      renderTransientDrawer(
        [
          ...renderQuestionPanel(
            {
              prompt: stripTerminalControls(question.prompt),
              options: optionList,
              cursor: cursorIndex,
              allowFreeform: hasFreeformRow,
              editor,
              caretVisible: this.#caretVisible,
              maxRows: this.#height() - hitlDrawerChromeRows,
            },
            this.#theme,
            width,
          ),
        ],
        ["↑/↓ move · enter to select · esc to dismiss"],
        this.#theme,
        width,
        this.#inputContextLabel(question.context),
        false,
        "left",
      );

    const textPanel = (width: number) => {
      const inputRows = promptInputRows({
        text: editor.text,
        cursor: editor.cursor,
        width: Math.max(1, width - 2),
        theme: this.#theme,
        caretVisible: this.#caretVisible,
        ghost: "",
        maxRows: 3,
      });
      if (inputRows.at(-1) === "") inputRows.pop();
      return renderTransientDrawer(
        fitQuestionPanel(
          [
            ...renderQuestionPrompt(question.prompt, this.#theme, width),
            "",
            ...inputRows.map((row) => `  ${row}`),
          ],
          this.#height() - hitlDrawerChromeRows,
        ),
        ["Enter submit · Esc dismiss"],
        this.#theme,
        width,
        this.#inputContextLabel(question.context),
        false,
        "left",
      );
    };

    const syncFreeformCaret = () => {
      if (isOnFreeformRow()) {
        this.#startCaretBlink();
      } else {
        this.#stopCaretBlink();
        this.#showCaret();
      }
    };

    const enterSelectDrawer = () => {
      mode = "select";
      this.#inputActive = false;
      this.#removeBlock(sectionKey);
      this.#hitlDrawer = selectDrawer;
      syncFreeformCaret();
      this.#paint();
    };

    const enterTextMode = () => {
      mode = "text";
      this.#hitlDrawer = textPanel;
      this.#inputActive = true;
      this.#syncInput(editor);
      this.#startCaretBlink();
      this.#paint();
    };

    if (mode === "select") enterSelectDrawer();
    else enterTextMode();

    const finalize = (resolved: {
      optionId?: string;
      text?: string;
      label: string;
    }): AgentTUIInputQuestionResponse => {
      this.#hitlDrawer = undefined;
      this.#upsertBlock({
        id: sectionKey,
        kind: "question",
        title: stripTerminalControls(question.prompt),
        body: `${this.#theme.colors.dim(this.#theme.glyph.elbow)}  ${stripTerminalControls(resolved.label)}`,
        preformatted: true,
        live: false,
      });
      this.#inputActive = false;
      this.#stopCaretBlink();
      this.#detachInput();
      this.#paint();
      const response: AgentTUIInputQuestionResponse = {};
      if (resolved.optionId !== undefined) response.optionId = resolved.optionId;
      if (resolved.text !== undefined) response.text = resolved.text;
      return response;
    };

    const dismiss = () => {
      this.#hitlDrawer = undefined;
      this.#upsertBlock({
        id: sectionKey,
        kind: "question",
        title: stripTerminalControls(question.prompt),
        body: `${this.#theme.colors.dim(this.#theme.glyph.elbow)}  ${this.#theme.colors.dim("Skipped. The question stays open.")}`,
        preformatted: true,
        live: false,
      });
      this.#inputActive = false;
      this.#stopCaretBlink();
      this.#detachInput();
      this.#paint();
      resolve(undefined);
    };

    const moveCursor = (delta: number) => {
      if (totalRows === 0) return;
      cursorIndex = (cursorIndex + delta + totalRows) % totalRows;
      syncFreeformCaret();
      this.#paint();
    };

    const selectOptionAt = (index: number) => {
      const option = optionList[index];
      if (option) resolve(finalize({ optionId: option.id, label: option.label }));
    };

    let resolve!: (value: AgentTUIInputQuestionResponse | undefined) => void;

    return await new Promise<AgentTUIInputQuestionResponse | undefined>((res, reject) => {
      this.#rejectActiveReader = reject;
      resolve = res;
      this.#consumeKey = (key) => {
        if (key.type === "ctrl-c") {
          const editing = mode === "text" || isOnFreeformRow();
          if (editing && editor.text.length > 0) {
            editor = EMPTY_LINE;
            this.#showCaret();
            if (mode === "text") this.#syncInput(editor);
            this.#paint();
            return;
          }
          this.#hitlDrawer = undefined;
          this.#stopCaretBlink();
          this.#stop();
          reject(interruptedError());
          return;
        }

        if (key.type === "ctrl-r") {
          this.#paint();
          return;
        }

        if (mode === "select") {
          const textNavigation = setupSelectionIntent(key, {
            textNavigation: !isOnFreeformRow(),
          });
          if (textNavigation?.kind === "move") {
            moveCursor(textNavigation.direction === "up" ? -1 : 1);
            return;
          }

          switch (key.type) {
            case "up":
            case "ctrl-p":
              moveCursor(-1);
              break;
            case "down":
            case "ctrl-n":
              moveCursor(1);
              break;
            case "enter": {
              if (isOnFreeformRow()) {
                const resolvedText = resolveQuestionText(editor.text, question);
                if (resolvedText !== undefined) resolve(finalize(resolvedText));
                break;
              }
              selectOptionAt(cursorIndex);
              break;
            }
            case "escape":
              if (isOnFreeformRow() && editor.text.length > 0) {
                editor = EMPTY_LINE;
                this.#showCaret();
                this.#paint();
                break;
              }
              dismiss();
              break;
            default: {
              if (isOnFreeformRow()) {
                const edited = this.#killRing.apply(editor, key);
                if (edited !== undefined) {
                  editor = edited;
                  this.#showCaret();
                  this.#paint();
                }
              }
              break;
            }
          }
          return;
        }

        const edited = this.#killRing.apply(editor, key, { multiline: true });
        if (edited !== undefined) {
          editor = edited;
          this.#showCaret();
          this.#syncInput(editor);
          this.#paint();
          return;
        }

        switch (key.type) {
          case "up":
          case "down": {
            const moved = movePromptLine(editor, key.type);
            if (moved !== undefined) {
              editor = moved;
              this.#showCaret();
              this.#syncInput(editor);
              this.#paint();
            }
            break;
          }
          case "enter": {
            const resolvedText = resolveQuestionText(editor.text, question);
            if (resolvedText === undefined) break;
            resolve(finalize(resolvedText));
            break;
          }
          case "escape":
            if (editor.text.length > 0) {
              editor = EMPTY_LINE;
              this.#showCaret();
              this.#syncInput(editor);
              this.#paint();
              break;
            }
            dismiss();
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  setVercelStatus(status: VercelStatusSnapshot): void {
    this.#vercelStatus = status;
    this.#paint();
  }

  setRemoteConnectionStatus(status: RemoteConnectionSnapshot): void {
    this.#remoteConnection = status;
    this.#paint();
  }

  reset(): void {
    this.#blocks = [];
    this.#blockById.clear();
    this.#committedIds.clear();
    this.#lastCommitted = undefined;
    this.#committedTranscriptRows.length = 0;
    this.#transcriptBlocks.length = 0;
    this.#agentHeaderRendered = false;
    this.#agentHeaderBody = undefined;
    this.#clearConversationState();
    this.#hasUserMessage = false;
    this.#devRebuild = undefined;
    if (this.#isInteractive) {
      this.#live.clearAll();
      this.#paint();
    }
  }

  renderSessionBoundary(label = "Session restarted, clear context."): void {
    this.#commitTurnStats();
    const stopped = this.#transcript.stopWorking(this.#transcriptOptions());
    for (const id of this.#conversationBlockIds) {
      const block = this.#blockById.get(id);
      if (block === undefined) continue;
      this.#blockById.delete(id);
      const index = this.#blocks.indexOf(block);
      const { id: _id, ...settled } = block;
      this.#blocks[index] = { ...settled, live: false };
    }
    for (const { id: _id, ...line } of stopped) this.#pushBlock(line);
    this.#committedIds.clear();
    this.#clearConversationState();

    const c = this.#theme.colors;
    const g = this.#theme.glyph;
    const body = c.dim(`${g.cornerOpen}${g.dash.repeat(2)} ${label}`);
    this.#pushBlock({ kind: "session-boundary", body, live: false });
    this.#paint();
  }

  #clearConversationState(): void {
    this.#transcript.reset();
    this.#view = undefined;
    this.#conversationBlockIds = new Set();
    this.#steeredMessages.length = 0;
    this.#cancelRequested = false;
    this.#turnClock.reset();
    this.#syncActivityTicker();
  }

  renderNotice(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#start();
    this.#pushBlock({ kind: "notice", body: content, live: false });
    this.#paint();
  }

  restoreDraft(text: string): void {
    const apply = this.#inputActive ? this.#applyDraft : undefined;
    if ((apply === undefined ? this.#draft.text : this.#inputText).length > 0) return;
    const line = lineOf(stripPromptControlCharacters(text));
    if (apply === undefined) this.#draft = line;
    else apply(line);
    this.renderNotice(
      "The turn was cancelled from outside this prompt, so its message is back in the input.",
    );
  }

  renderSetupWarning(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) {
      this.#clearSetupAttention();
      return;
    }
    this.#start();
    this.#setupAttention = content;
    this.#paint();
  }

  clearSetupWarning(): void {
    this.#clearSetupAttention();
  }

  #clearSetupAttention(): void {
    if (this.#setupAttention === undefined) return;
    this.#setupAttention = undefined;
    this.#paint();
  }

  renderCommandInvocation(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#start();
    this.#pushCommandEcho(content);
    this.#paint();
  }

  async choosePromptCommand(commands: readonly PromptCommandSpec[]): Promise<string | undefined> {
    this.#start();
    this.#inputActive = false;
    let state = typeaheadFor(commands, "/");
    this.#transientPanel = (width) => {
      const rows = renderCommandSuggestions(state, this.#theme, width);
      const visible = Math.max(1, this.#height() - 7);
      const start = Math.max(0, Math.min(state.selectedIndex - visible + 1, rows.length - visible));
      return renderTransientDrawer(
        rows.slice(start, start + visible),
        ["↑/↓ move · Enter select · Esc close"],
        this.#theme,
        width,
      );
    };
    this.#paint();
    return await new Promise((resolve) => {
      this.#transientPanelClose = () => resolve(undefined);
      this.#consumeKey = (key) => {
        if (key.type === "up" || key.type === "ctrl-p") {
          state = moveTypeaheadSelection(state, -1);
          this.#paint();
        } else if (key.type === "down" || key.type === "ctrl-n") {
          state = moveTypeaheadSelection(state, 1);
          this.#paint();
        } else if (key.type === "enter") {
          const command = selectedTypeaheadCommand(state);
          this.#closeTransientPanel();
          resolve(command === undefined ? undefined : typeaheadCompletion(command));
        } else if (key.type === "escape" || key.type === "ctrl-c") {
          this.#closeTransientPanel();
          resolve(undefined);
        }
      };
      this.#attachInput();
    });
  }

  async showInfoPanel(text: string): Promise<void> {
    this.#start();
    this.#inputActive = false;
    const plainText = stripAnsi(text);
    let scroll = 0;
    const infoRows = (width: number) =>
      plainText
        .split("\n")
        .flatMap((line) =>
          wrapVisibleLine(line, Math.max(1, width - 4)).map((part) => `  ${part}`),
        );
    this.#transientPanel = (width) => {
      const rows = infoRows(width);
      const visible = Math.max(1, this.#height() - 7);
      scroll = Math.min(scroll, Math.max(0, rows.length - visible));
      return renderTransientDrawer(
        rows.slice(scroll, scroll + visible),
        [rows.length > visible ? "↑/↓ scroll · Esc close" : "Esc to close"],
        this.#theme,
        width,
      );
    };
    this.#paint();
    await new Promise<void>((resolve) => {
      this.#transientPanelClose = resolve;
      this.#consumeKey = (key) => {
        if (key.type === "up" || key.type === "ctrl-p") {
          scroll = Math.max(0, scroll - 1);
          this.#paint();
        } else if (key.type === "down" || key.type === "ctrl-n") {
          const visible = Math.max(1, this.#height() - 7);
          scroll = Math.min(scroll + 1, Math.max(0, infoRows(this.#width()).length - visible));
          this.#paint();
        } else if (key.type === "escape" || key.type === "ctrl-c" || key.type === "enter") {
          this.#closeTransientPanel();
          resolve();
        }
      };
      this.#attachInput();
    });
  }

  #closeTransientPanel(): void {
    this.#transientPanel = undefined;
    this.finishCommand({ kind: "dismiss" });
    this.#consumeKey = undefined;
    this.#transientPanelClose = undefined;
    this.#detachInput();
    this.#paint();
  }

  finishCommand(outcome: CommandPresentation): void {
    if (outcome.kind === "dismiss") {
      if (this.#removePendingCommandEcho()) this.#paint();
      return;
    }
    const echo = this.#settleCommandEcho(outcome.summary);
    if (echo !== undefined) echo.status = "done";
    const content = outcome.message === undefined ? "" : stripAnsi(outcome.message);
    if (content.trim().length === 0) {
      if (echo !== undefined) this.#paint();
      return;
    }
    this.#start();
    const result: Block = { kind: "result", body: content, live: false };
    this.#pushBlock(result);
    const echoIndex = echo === undefined ? -1 : this.#blocks.indexOf(echo);
    if (echoIndex !== -1) {
      this.#blocks.pop();
      this.#blocks.splice(echoIndex + 1, 0, result);
    }
    this.#paint();
  }

  #removePendingCommandEcho(): boolean {
    const block = this.#pendingCommandEcho;
    if (block === undefined) return false;
    this.#pendingCommandEcho = undefined;
    this.#blocks = this.#blocks.filter((candidate) => candidate !== block);
    return true;
  }

  #pushCommandEcho(body: string): void {
    if (this.#pendingCommandEcho !== undefined) this.#settleCommandEcho();
    const block: Block = { kind: "command", body, live: true };
    this.#pendingCommandEcho = block;
    this.#pushBlock(block);
  }

  #settleCommandEcho(summary?: string): Block | undefined {
    const block = this.#pendingCommandEcho;
    if (block === undefined) return undefined;
    this.#pendingCommandEcho = undefined;
    block.live = false;
    if (summary !== undefined) block.result = stripTerminalControls(summary);
    return block;
  }

  #beginSetupFlow(title: string): void {
    this.#start();
    if (this.#startupEditor === undefined) this.#inputActive = false;
    this.#setupFlow = {
      title: stripTerminalControls(title),
      startedAtMs: Date.now(),
      lines: [],
      outputBuffer: [],
    };
    this.#startTicker();
    this.#paint();
  }

  #setSetupFlowNavigation(navigation: PlannerNavigation | undefined): void {
    if (this.#setupFlow === undefined) return;
    this.#setupFlow.navigation = navigation;
    this.#paint();
  }

  #endSetupFlow(preserveDiagnostics: boolean): void {
    this.#flowInterrupt = undefined;
    this.#disarmFlowIdleTrap();
    const flow = this.#setupFlow;
    if (flow === undefined) return;
    this.#setupFlow = undefined;
    if (this.#startupEditor !== undefined) this.#resumeStartupDraft();
    else this.#stopTicker();

    if (preserveDiagnostics) {
      let evidence: string[] = [];
      for (const line of flow.lines) {
        if (line.evidence === true) {
          evidence.push(line.text);
          continue;
        }
        if (line.tone === "warning" || line.tone === "error") {
          if (evidence.length > 0) {
            this.#pushBlock({
              kind: "flow",
              title: "info",
              body: evidence.join("\n"),
              live: false,
            });
          }
          this.#pushBlock({ kind: "flow", title: line.tone, body: line.text, live: false });
        }
        evidence = [];
      }
    }
    this.#paint();
  }

  async #readSetupSelect(opts: SetupSelectRequest): Promise<SetupSelectResult> {
    const flow = this.#beginSetupQuestion(opts.message);
    const multiple = isMultiSelectRequest(opts);
    const searchAction = opts.kind === "search" ? opts.searchAction : undefined;
    const searchableField = opts.kind === "search" && opts.layout === undefined;
    let selectOptions: readonly SetupPanelOption[] = opts.options;

    const plannerNavigation = opts.navigation?.kind === "planner";
    const initial: Parameters<typeof initialSelectState>[0] = {
      options: selectOptions,
      searchAction,
      submitRow: multiple && !plannerNavigation,
    };
    if ("initialValue" in opts && opts.initialValue !== undefined) {
      initial.defaultValue = opts.initialValue;
    }
    if ("initialValues" in opts && opts.initialValues !== undefined) {
      initial.initialValues = opts.initialValues;
    }
    let select: SelectState = initialSelectState(initial);
    let error: string | undefined;
    let loading = false;
    let searchVersion = 0;

    const isCurrentSearch = (version: number): boolean => version === searchVersion;
    const clearSearch = (): void => {
      searchVersion += 1;
      loading = false;
      select = reduceSelect(
        select,
        { type: "clear" },
        {
          options: selectOptions,
          searchAction,
          submitRow: multiple && !plannerNavigation,
        },
      );
      this.#paint();
    };
    const loadSearch = async (
      query: string,
      load: (query: string) => Promise<readonly SetupPanelOption[]>,
    ): Promise<void> => {
      loading = true;
      error = undefined;
      const version = ++searchVersion;
      this.#paint();

      try {
        const options = await load(query);
        if (!isCurrentSearch(version)) return;

        const filter = select.filter;
        selectOptions = options;
        select = {
          ...initialSelectState({
            options,
            searchAction,
            submitRow: multiple && !plannerNavigation,
          }),
          filter,
        };
      } catch (reason) {
        if (isCurrentSearch(version)) error = toErrorMessage(reason);
      } finally {
        if (isCurrentSearch(version)) {
          loading = false;
          this.#paint();
        }
      }
    };

    let notices = opts.notices;
    if (opts.kind === "task-list" || (opts.kind === "search" && opts.layout === "task-list")) {
      const start = flow.taskListLineStart ?? flow.lines.length;
      const outcomes: SelectNotice[] = flow.lines
        .slice(start)
        .filter(
          (line): line is FlowPanelLine & { tone: "success" | "warning" | "error" } =>
            line.tone === "success" || line.tone === "warning" || line.tone === "error",
        )
        .map((line) => ({ tone: line.tone, text: line.text }));
      notices = opts.notices ?? outcomes;
      flow.taskListLineStart = flow.lines.length;
      flow.hideLinesWhileQuestion = true;
    }
    const panelState = (): SetupOptionPanelState => {
      const state: SetupOptionPanelState = { ...opts, message: "", options: selectOptions, select };
      if (notices !== undefined && notices.length > 0) state.notices = notices;
      if (error !== undefined) state.error = error;
      if (loading) state.loadingFrame = this.#spinnerFrame();
      if (searchableField) state.caretVisible = this.#caretVisible;
      return state;
    };
    flow.question = (width) => renderSelectQuestion(panelState(), this.#theme, width);
    if (searchableField) this.#startCaretBlink();
    this.#paint();

    const question = this.#captureSetupQuestion<SetupSelectResult>(
      (key, settle) => {
        const close = (value: SetupSelectResult): void => {
          searchVersion += 1;
          settle(value);
        };
        if (loading) {
          if (key.type === "ctrl-c") close(undefined);
          else if (key.type === "escape") clearSearch();
          else if (key.type === "ctrl-r") this.#paint();
          return;
        }

        const plannerStep = opts.navigation?.kind === "planner" ? opts.navigation : undefined;
        const plannerDirection =
          key.type === "left" &&
          (plannerStep?.activeStep ?? 0) > (plannerStep?.firstNavigableStep ?? 0)
            ? "back"
            : key.type === "right" &&
                plannerStep !== undefined &&
                plannerStep.activeStep >= (plannerStep.firstNavigableStep ?? 0) &&
                plannerStep.activeStep < plannerStep.steps.length - 1
              ? "forward"
              : undefined;
        if (plannerDirection !== undefined) {
          close({
            kind: "navigate",
            direction: plannerDirection,
            values: multiple ? orderedSelection(selectOptions, select.selected) : [],
          });
          return;
        }

        const base = { key, options: selectOptions, searchAction, select };
        const result = multiple
          ? reduceSetupSelectInput({
              ...base,
              kind: opts.kind,
              required: opts.required,
              plannerNavigation: plannerNavigation || undefined,
            })
          : reduceSetupSelectInput({ ...base, kind: opts.kind });
        switch (result.kind) {
          case "cancel":
            close(undefined);
            return;
          case "repaint":
            this.#paint();
            return;
          case "update":
            select = result.select;
            error = undefined;
            if (searchableField) this.#showCaret();
            this.#paint();
            return;
          case "submit": {
            const query = searchActionQuery(result.values[0] ?? "");
            const load = searchAction?.load;
            if (query === undefined || load === undefined) {
              close(result.values);
              return;
            }

            void loadSearch(query, load);
            return;
          }
          case "error":
            error = result.message;
            this.#paint();
            return;
          case "ignore":
            return;
        }
      },
      searchableField ? () => this.#stopCaretBlink() : undefined,
    );
    return await question.promise;
  }

  #readSetupChoice(
    opts: Parameters<SetupFlowRenderer["readChoice"]>[0],
  ): ReturnType<SetupFlowRenderer["readChoice"]> {
    this.#start();
    const flow = this.#requireSetupFlow();
    flow.status = {
      text: stripTerminalControls(opts.status),
      startedAtMs: Date.now(),
    };
    let cursor: number | undefined;
    flow.question = (width) =>
      renderSelectQuestion(
        {
          kind: "actions",
          context: opts.context,
          actions: opts.actions,
          cursor,
        },
        this.#theme,
        width,
      );
    this.#paint();

    const question = this.#captureSetupQuestion<string | undefined>(
      (key, settle) => {
        const intent = setupSelectionIntent(key, { textNavigation: true });
        switch (intent?.kind) {
          case "cancel":
            settle(undefined);
            return;
          case "move":
            cursor = moveActionCursor(cursor, intent.direction, opts.actions.length);
            this.#paint();
            return;
          case "repaint":
            this.#paint();
            return;
          case "submit": {
            if (cursor !== undefined) settle(opts.actions[cursor]!.value);
            return;
          }
          case undefined:
            return;
        }
      },
      () => {
        flow.status = undefined;
      },
    );
    return { choice: question.promise, close: () => question.settle(undefined) };
  }

  async #readSetupEditableSelect(opts: {
    message: string;
    options: readonly SetupPanelOption[];
    initialValue?: string;
    editable: {
      value: string;
      defaultValue: string;
      formatHint: (value: string) => string;
      validate?: (value: string) => string | undefined;
    };
  }): Promise<SetupEditableSelectResult | undefined> {
    const flow = this.#beginSetupQuestion(opts.message);

    const initial: Parameters<typeof initialSelectState>[0] = { options: opts.options };
    if (opts.initialValue !== undefined) initial.defaultValue = opts.initialValue;
    let select = initialSelectState(initial);
    let editor = lineOf("");
    let error: string | undefined;

    flow.question = (width) => {
      const state: SetupSelectPanelState = {
        kind: "inline-edit",
        layout: "task-list",
        message: "",
        options: opts.options,
        select,
        edit: {
          optionValue: opts.editable.value,
          caretVisible: this.#caretVisible,
          editor: {
            kind: "rename",
            editor,
            defaultValue: opts.editable.defaultValue,
            formatHint: opts.editable.formatHint,
          },
        },
      };
      if (error !== undefined) state.error = error;
      return renderSelectQuestion(state, this.#theme, width);
    };
    const onEditableRow = () =>
      selectValueAtCursor([...opts.options], select.cursor) === opts.editable.value;
    const syncEditableRow = () => {
      if (onEditableRow()) {
        this.#startCaretBlink();
      } else {
        editor = lineOf("");
        this.#stopCaretBlink();
      }
    };
    syncEditableRow();
    this.#paint();

    const question = this.#captureSetupQuestion<SetupEditableSelectResult | undefined>(
      (key, settle) => {
        const applyEditor = (next: LineState) => {
          editor = next;
          error = undefined;
          this.#showCaret();
          this.#paint();
        };
        const applySelect = (event: Parameters<typeof reduceSelect>[1]) => {
          select = reduceSelect(select, event, { options: opts.options });
          error = undefined;
          syncEditableRow();
          this.#paint();
        };
        const submit = () => {
          const value = selectValueAtCursor([...opts.options], select.cursor);
          if (value === undefined) return;
          if (value !== opts.editable.value) {
            settle({ kind: "selected", value });
            return;
          }
          const text = (editor.text || opts.editable.defaultValue).trim();
          const invalid = opts.editable.validate?.(text);
          if (invalid !== undefined) {
            error = invalid;
            this.#paint();
            return;
          }
          settle(
            text === opts.editable.defaultValue
              ? { kind: "selected", value }
              : { kind: "edited", value, text },
          );
        };

        const intent = setupSelectionIntent(key, { textNavigation: !onEditableRow() });
        switch (intent?.kind) {
          case "cancel":
            settle(undefined);
            return;
          case "move":
            applySelect({ type: intent.direction });
            return;
          case "submit":
            submit();
            return;
          case "repaint":
            this.#paint();
            return;
          case undefined:
            break;
        }

        if (!onEditableRow()) return;
        const edited = this.#killRing.apply(editor, key);
        if (edited !== undefined) applyEditor(edited);
      },
      () => this.#stopCaretBlink(),
    );
    return await question.promise;
  }

  async #readProviderPicker(
    opts: ProviderPickerRequest,
  ): Promise<ProviderPickerChoice | undefined> {
    this.#killRing.clear();
    const flow = this.#beginSetupQuestion(opts.message);
    let interaction = initialProviderPickerState(opts.options, opts.initialValue);
    let validation: AbortController | undefined;

    const cursorBadge = (): string | undefined => {
      if (interaction.phase.kind !== "inactive") return undefined;
      const value = selectValueAtCursor([...opts.options], interaction.select.cursor);
      const row = opts.options.find((option) => option.value === value);
      if (row === undefined) return undefined;
      return enterBadge(this.#theme, row.checked === true ? "change" : undefined);
    };

    flow.question = (width) => {
      const badge = cursorBadge();
      const panel: SetupSelectPanelState = {
        kind: "inline-edit",
        layout: "stacked",
        message: "",
        options: opts.options,
        select: interaction.select,
        edit: {
          optionValue: "ai-gateway-key",
          caretVisible: this.#caretVisible,
          editor: { kind: "key", phase: interaction.phase },
        },
      };
      if (badge !== undefined) panel.cursorBadge = badge;
      return renderSelectQuestion(panel, this.#theme, width);
    };

    const syncCaret = () => {
      if (interaction.phase.kind === "editing" || interaction.phase.kind === "invalid") {
        this.#startCaretBlink();
      } else {
        this.#stopCaretBlink();
      }
    };
    syncCaret();
    this.#paint();

    const question = this.#captureSetupQuestion<ProviderPickerChoice | undefined>(
      (key, settle, reject) => {
        const dispatch = (event: ProviderPickerEvent) => {
          const transition = transitionProviderPicker(interaction, event, opts.options);
          switch (transition.kind) {
            case "ignore":
              return;
            case "clear":
              validation?.abort();
              validation = undefined;
              interaction = transition.state;
              syncCaret();
              this.#paint();
              return;
            case "cancel":
              settle(undefined);
              return;
            case "render":
              interaction = transition.state;
              syncCaret();
              this.#paint();
              return;
            case "validate": {
              interaction = transition.state;
              syncCaret();
              this.#paint();
              const controller = new AbortController();
              validation = controller;
              let result: ReturnType<typeof opts.validateInlineKey>;
              try {
                result = opts.validateInlineKey(transition.key, controller.signal);
              } catch (error) {
                reject(error);
                return;
              }
              void result.then(
                (outcome) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  dispatch({ type: "validated", validation: outcome });
                },
                (error: unknown) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  reject(error);
                },
              );
              return;
            }
            case "settle":
              settle(transition.result);
              return;
          }
        };

        const intent = setupSelectionIntent(key, {
          textNavigation: interaction.phase.kind === "inactive",
        });
        switch (intent?.kind) {
          case "cancel":
            dispatch({ type: "cancel" });
            return;
          case "move":
            dispatch({ type: "move", direction: intent.direction });
            return;
          case "submit":
            dispatch({ type: "submit" });
            return;
          case "repaint":
            this.#paint();
            return;
          case undefined:
            break;
        }

        if (interaction.phase.kind !== "editing" && interaction.phase.kind !== "invalid") return;
        const edited = applyLineEditorKey(interaction.phase.editor, key);
        if (edited !== undefined) {
          this.#showCaret();
          dispatch({ type: "edit", editor: edited });
        }
      },
      () => {
        validation?.abort();
        validation = undefined;
        this.#stopCaretBlink();
      },
    );
    return await question.promise;
  }

  async #readSetupText(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
    notices?: readonly SelectNotice[];
  }): Promise<string | undefined> {
    if (opts.mask === true) this.#killRing.clear();
    const flow = this.#beginSetupQuestion(opts.message);

    let editor: LineState = lineOf("");
    let error: string | undefined;

    flow.question = (width) => {
      const state: Parameters<typeof renderTextQuestion>[0] = {
        message: "",
        editor,
        mask: opts.mask === true,
      };
      if (opts.placeholder !== undefined) state.placeholder = opts.placeholder;
      else if (opts.defaultValue !== undefined) state.placeholder = opts.defaultValue;
      if (opts.notices !== undefined) state.notices = opts.notices;
      if (error !== undefined) state.error = error;
      return renderTextQuestion(state, this.#theme, width, this.#caretVisible);
    };
    this.#startCaretBlink();
    this.#paint();

    const question = this.#captureSetupQuestion<string | undefined>(
      (key, settle) => {
        const apply = (next: LineState) => {
          editor = next;
          error = undefined;
          this.#showCaret();
          this.#paint();
        };

        const edited = opts.mask
          ? applyLineEditorKey(editor, key)
          : this.#killRing.apply(editor, key);
        if (edited !== undefined) {
          apply(edited);
          return;
        }
        switch (key.type) {
          case "ctrl-c":
          case "escape":
            settle(undefined);
            return;
          case "ctrl-r":
            this.#paint();
            return;
          case "enter": {
            const value = editor.text.length > 0 ? editor.text : (opts.defaultValue ?? "");
            const invalid = opts.validate?.(value);
            if (invalid !== undefined) {
              error = invalid;
              this.#paint();
              return;
            }
            settle(value);
            return;
          }
          default:
            return;
        }
      },
      () => this.#stopCaretBlink(),
    );
    return await question.promise;
  }

  async #readSetupAcknowledge(opts: { message: string; lines: readonly string[] }): Promise<void> {
    const flow = this.#beginSetupQuestion(opts.message);

    flow.question = (width) =>
      renderAcknowledgeQuestion({ message: "", lines: opts.lines }, this.#theme, width);
    this.#paint();

    const question = this.#captureSetupQuestion<void>((key, settle) => {
      switch (key.type) {
        case "enter":
        case "escape":
        case "ctrl-c":
          settle();
          return;
        case "ctrl-r":
          this.#paint();
          return;
        default:
          return;
      }
    });
    return await question.promise;
  }

  #beginSetupQuestion(title: string): SetupFlowState {
    this.#start();
    this.#inputActive = false;
    const flow = this.#requireSetupFlow();
    flow.questionTitle = stripTerminalControls(title);
    if (flow.status !== undefined) {
      flow.status = undefined;
      flow.summary = undefined;
      flow.preview = undefined;
    }
    return flow;
  }

  #requireSetupFlow(): SetupFlowState {
    if (this.#setupFlow === undefined) {
      this.#setupFlow = {
        title: "",
        startedAtMs: Date.now(),
        lines: [],
        outputBuffer: [],
        implicit: true,
      };
    }
    return this.#setupFlow;
  }

  #closeSetupQuestion(): void {
    if (this.#setupFlow?.implicit === true) {
      this.#setupFlow = undefined;
    } else if (this.#setupFlow !== undefined) {
      this.#setupFlow.question = undefined;
      this.#setupFlow.questionTitle = undefined;
      this.#setupFlow.hideLinesWhileQuestion = false;
    }
    this.#consumeKey = undefined;
    this.#detachInput();
    if (this.#startupEditor !== undefined) this.#resumeStartupDraft();
    else if (this.#setupFlow !== undefined) this.#armFlowIdleTrap();
    if (this.#setupFlow === undefined) this.#paint();
  }

  #captureSetupQuestion<T>(
    consume: (
      key: TerminalKey,
      settle: (value: T) => void,
      reject: (error: unknown) => void,
    ) => void,
    beforeClose?: () => void,
  ): { promise: Promise<T>; settle(value: T): void } {
    let settled = false;
    let resolve!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, reject) => {
      resolve = resolvePromise;
      rejectPromise = reject;
    });
    const settle = (value: T): void => {
      if (settled) return;
      settled = true;
      beforeClose?.();
      this.#closeSetupQuestion();
      resolve(value);
    };
    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      beforeClose?.();
      this.#closeSetupQuestion();
      rejectPromise(error);
    };
    this.#clearKeyFlush();
    this.#consumeKey = (key) => {
      if (key.type === "ctrl-c") {
        this.#requestExit();
      }
      consume(key, settle, reject);
    };
    this.#attachInput();
    return { promise, settle };
  }

  #waitForFlowInterrupt(options?: { interruptible?: boolean }): {
    promise: Promise<SetupFlowInterrupt>;
    dispose(): void;
  } {
    let fire!: (interrupt: SetupFlowInterrupt) => void;
    const promise = new Promise<SetupFlowInterrupt>((resolve) => {
      fire = resolve;
    });
    this.#flowInterrupt = fire;
    this.#armFlowIdleTrap(options?.interruptible ?? true);
    return {
      promise,
      dispose: () => {
        if (this.#flowInterrupt !== fire) return;
        this.#flowInterrupt = undefined;
        this.#disarmFlowIdleTrap();
      },
    };
  }

  #armFlowIdleTrap(interruptible = true): void {
    if (this.#startupEditor !== undefined) {
      this.#resumeStartupDraft();
      return;
    }
    if (this.#flowInterrupt === undefined) return;
    const consumer = (key: TerminalKey): void => {
      if (interruptible && (key.type === "ctrl-c" || key.type === "escape")) {
        if (key.type === "ctrl-c") {
          this.#requestExit();
        }
        const fire = this.#flowInterrupt;
        this.#flowInterrupt = undefined;
        this.#disarmFlowIdleTrap();
        fire?.(key.type === "ctrl-c" ? "ctrl-c" : "escape");
        return;
      }
      if (key.type === "ctrl-r") this.#paint();
    };
    this.#flowIdleConsumer = consumer;
    this.#clearKeyFlush();
    this.#consumeKey = consumer;
    this.#attachInput();
  }

  #disarmFlowIdleTrap(): void {
    if (this.#flowIdleConsumer === undefined) return;
    if (this.#consumeKey === this.#flowIdleConsumer) {
      this.#detachInput();
    }
    this.#flowIdleConsumer = undefined;
  }

  #setFlowStatus(status: string | undefined): void {
    const content: SetupFlowStatusState | undefined =
      status === undefined
        ? undefined
        : { text: stripTerminalControls(status), startedAtMs: Date.now() };
    if (this.#setupFlow !== undefined) {
      this.#setupFlow.status = content;
      if (content === undefined) this.#setupFlow.preview = undefined;
      this.#paint();
      return;
    }
    if (this.#inputActive || this.#view?.working === true) {
      return;
    }
    if (content === undefined) {
      this.#flowlessStatus = undefined;
      this.#stopTicker();
      this.#paint();
      return;
    }
    this.#start();
    this.#activityPulseStartedAtMs = Date.now();
    this.#startTicker();
    this.#flowlessStatus = content.text;
    this.#paint();
  }

  #renderFlowLine(text: string, tone: "info" | "success" | "warning" | "error"): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#setupFlow;
    if (flow !== undefined) {
      flow.preview = undefined;
      if (tone === "warning" || tone === "error") {
        for (const buffered of flow.outputBuffer) {
          flow.lines.push({ text: buffered, tone: "info", evidence: true });
        }
      }
      flow.outputBuffer = [];
      flow.lines.push({ text: content, tone });
      this.#paint();
      return;
    }
    this.#start();
    this.#pushBlock({ kind: "flow", title: tone, body: content, live: false });
    this.#paint();
  }

  #replaceFlowContent(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void {
    const flow = this.#setupFlow;
    if (flow === undefined) return;
    flow.lines = [];
    flow.outputBuffer = [];
    flow.preview = undefined;
    flow.status = undefined;
    flow.summary =
      content === undefined
        ? undefined
        : {
            headline: stripTerminalControls(content.headline),
            facts: content.facts.map((fact) => ({
              label: stripTerminalControls(fact.label),
              value: stripTerminalControls(fact.value),
            })),
          };
    this.#paint();
  }

  #renderFlowOutput(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#setupFlow;
    if (flow === undefined) {
      this.#renderFlowLine(content, "info");
      return;
    }
    flow.preview = content;
    flow.outputBuffer.push(content);
    if (flow.outputBuffer.length > FLOW_OUTPUT_BUFFER_CAP) flow.outputBuffer.shift();
    this.#paint();
  }

  async #withInheritedStdio<T>(task: () => Promise<T>): Promise<T> {
    this.#keyBuffer = "";
    this.#clearKeyFlush();
    this.#flowInterrupt = undefined;
    this.#disarmFlowIdleTrap();
    this.#detachInput();
    this.#clearTicker();
    this.#live.clear();
    this.#removeLogCapture();
    this.#altScreen.enter({ cursor: "visible", mouse: false });
    if (this.#input.isTTY) this.#input.setRawMode?.(false);
    this.#input.pause();
    try {
      return await task();
    } finally {
      this.#altScreen.exit();
      if (this.#input.isTTY) this.#input.setRawMode?.(true);
      this.#input.resume();
      this.#keyBuffer = "";
      this.#clearKeyFlush();
      this.#live.hideCursor();
      this.#installLogCapture();
      if (this.#setupFlow !== undefined) {
        this.#startTicker();
        this.#armFlowIdleTrap();
      } else {
        this.#syncActivityTicker();
      }
      this.#live.reset();
      this.#paint();
    }
  }

  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  shutdown(): void {
    this.#stop();
    for (const timer of this.#argumentCatalogLoadingTimers.values()) clearTimeout(timer);
    this.#argumentCatalogLoadingTimers.clear();
    if (this.#everInteractive && !this.#partingLinePrinted) {
      this.#partingLinePrinted = true;
      const session =
        this.#sessionId === undefined ? "" : ` ${this.#theme.glyph.dot} session ${this.#sessionId}`;
      this.#output.write(`${this.#theme.colors.dim(`${eveVersionTag()}${session}`)}\n`);
    }
  }

  handOff(committedRows?: readonly string[]): void {
    this.#handingOff = true;
    this.#partingLinePrinted = true;
    if (committedRows === undefined) return;
    this.#composerPending = false;
    this.#startupPreamble = [];
    this.#pendingCommittedRows.push(...committedRows);
    this.#paint();
    this.#frameKept = true;
  }

  requestInterrupt(): void {
    if (this.#setupFlow !== undefined) this.#consumeKey?.({ type: "ctrl-c" });
    this.#stop();
  }

  exitRequested(): boolean {
    return this.#exitRequested;
  }

  #requestExit(): void {
    this.#exitRequested = true;
    this.#onExitRequest?.();
  }

  async #openTraceViewer(options: TraceViewerOpenOptions): Promise<void> {
    if (this.#traceView !== undefined || !this.#isInteractive) return;
    const session = new TraceViewerSession({
      ...options,
      theme: this.#theme,
      dimensions: () => ({ width: this.#width(), height: this.#height() }),
      paint: (rows) => this.#altScreen.paint(rows, this.#height()),
      tracingDisabled: process.env.EVE_TRACES === "off",
      copyText: (text) => copyTextToClipboard(text, (chunk) => this.#altScreen.writeRaw(chunk)),
      terminalBackground: this.#terminalBackground,
    });
    this.#traceView = session;
    this.#altScreen.enter();
    if (this.#theme.color) this.#altScreen.writeRaw(BACKGROUND_COLOR_QUERY);
    await new Promise<void>((resolve) => {
      this.#traceViewClose = resolve;
      this.#consumeKey = (key) => {
        if (session.handleKey(key) === "close") this.#closeTraceViewer();
      };
      this.#attachInput();
      session.start();
    });
  }

  #closeTraceViewer(): void {
    const session = this.#traceView;
    if (session === undefined) return;
    this.#traceView = undefined;
    session.dispose();
    this.#detachInput();
    this.#altScreen.exit();
    this.#live.hideCursor();
    this.#paint();
    this.#live.showCursor();
    const resolve = this.#traceViewClose;
    this.#traceViewClose = undefined;
    resolve?.();
  }

  #traceViewClose?: () => void;

  #start(options?: AgentTUISessionOptions) {
    this.#title = options?.title ?? this.#title;

    if (this.#isInteractive) return;

    this.#isInteractive = true;
    this.#everInteractive = true;
    this.#live.reset();
    this.#live.hideCursor();
    this.#installLogCapture();

    if (this.#input.isTTY) {
      this.#input.setRawMode?.(true);
      this.#input.resume();
      this.#live.emitBracketedPaste(true);
    }

    this.#onResize = () => this.#paint();
    this.#output.on("resize", this.#onResize);
    process.on("exit", this.#onProcessExit);
  }

  readonly #onProcessExit = () => {
    if (!this.#isInteractive) return;
    this.#altScreen.exit();
    if (this.#input.isTTY) {
      this.#live.emitBracketedPaste(false);
      this.#input.setRawMode?.(false);
    }
    this.#live.showCursor();
  };

  #stop() {
    this.#hitlDrawer = undefined;
    const closeTransientPanel = this.#transientPanelClose;
    if (closeTransientPanel !== undefined) {
      this.#transientPanelClose = undefined;
      this.#transientPanel = undefined;
      this.finishCommand({ kind: "dismiss" });
      this.#consumeKey = undefined;
      closeTransientPanel();
    }
    this.#closeTraceViewer();
    const rejectReader = this.#rejectActiveReader;
    this.#rejectActiveReader = undefined;
    rejectReader?.(interruptedError());
    this.#detachInput();
    this.#stopCaretBlink();
    this.#clearTicker();
    if (this.#logLevelHintTimer !== undefined) {
      clearTimeout(this.#logLevelHintTimer);
      this.#logLevelHintTimer = undefined;
    }
    this.#logLevelHintActive = false;
    this.#clearDevBuildStatus();

    if (!this.#isInteractive) return;

    this.#settleDevRebuildStatus();
    this.#settleCommandEcho();
    for (const block of this.#blocks) {
      if (block.kind === "log" && block.id === undefined) block.live = false;
    }
    this.#composerPending = false;
    this.#paint();

    if (this.#frameKept) {
      this.#live.release();
    } else {
      this.#live.clear();
      this.#live.showCursor();
    }
    this.#removeLogCapture();
    if (!this.#handingOff) this.#live.newline();

    if (this.#input.isTTY) {
      this.#live.emitBracketedPaste(false);
      this.#input.setRawMode?.(false);
      this.#input.pause();
    }

    if (this.#onResize) {
      this.#output.off("resize", this.#onResize);
      this.#onResize = undefined;
    }
    process.off("exit", this.#onProcessExit);

    this.#isInteractive = false;
  }

  #attachInput() {
    this.#input.off("data", this.#feedRaw);
    this.#input.on("data", this.#feedRaw);
    if (this.#keyBuffer.length > 0) {
      queueMicrotask(() => {
        if (this.#consumeKey !== undefined && this.#keyBuffer.length > 0) {
          this.#drainKeys();
          this.#armKeyFlush();
        }
      });
    }
  }

  #detachInput() {
    this.#input.off("data", this.#feedRaw);
    this.#clearKeyFlush();
    this.#consumeKey = undefined;
  }

  readonly #feedRaw = (chunk: Buffer) => {
    this.#clearKeyFlush();
    this.#keyBuffer += this.#inputDecoder.write(chunk);
    this.#drainKeys();
    this.#armKeyFlush();
  };

  #armKeyFlush() {
    if (this.#keyBuffer === "\x1b") {
      this.#keyFlushTimer = setTimeout(() => {
        if (this.#keyBuffer !== "\x1b") return;
        this.#keyBuffer = "";
        this.#dispatchKey({ type: "escape" });
      }, escFlushMs);
      this.#keyFlushTimer.unref?.();
      return;
    }
    if (isIncompletePaste(this.#keyBuffer)) {
      const stuck = this.#keyBuffer;
      this.#keyFlushTimer = setTimeout(() => {
        if (this.#keyBuffer !== stuck) return;
        const value = sanitizePastedText(stripPasteStart(stuck));
        this.#keyBuffer = "";
        if (value.length > 0) {
          this.#dispatchKey({ type: "text", value, framing: "bracketed-paste" });
        }
      }, incompletePasteFlushMs);
      this.#keyFlushTimer.unref?.();
      return;
    }
    if (isIncompleteOsc(this.#keyBuffer)) {
      const stuck = this.#keyBuffer;
      this.#keyFlushTimer = setTimeout(() => {
        if (this.#keyBuffer !== stuck) return;
        this.#keyBuffer = "";
      }, incompletePasteFlushMs);
      this.#keyFlushTimer.unref?.();
    }
  }

  #dispatchKey(key: TerminalKey): void {
    this.#killRing.interruptYank(key);
    this.#consumeKey?.(key);
  }

  #drainKeys() {
    while (this.#keyBuffer.length > 0) {
      const token = nextKey(this.#keyBuffer);
      if (token.incomplete) return;
      this.#keyBuffer = this.#keyBuffer.slice(token.consumed);
      if (token.key === undefined || token.key.type === "ignore") continue;
      if (token.key.type === "osc") {
        this.#handleOscReply(token.key.value);
        continue;
      }
      this.#dispatchKey(token.key);
    }
  }

  #handleOscReply(value: string): void {
    const background = parseBackgroundColorReply(value);
    if (background === undefined) return;
    this.#terminalBackground = background;
    this.#traceView?.setTerminalBackground(background);
  }

  #clearKeyFlush() {
    if (this.#keyFlushTimer) {
      clearTimeout(this.#keyFlushTimer);
      this.#keyFlushTimer = undefined;
    }
  }

  #startCaretBlink() {
    this.#stopCaretBlink();
    this.#showCaret();
    this.#caretTimer = setInterval(() => {
      this.#caretVisible = !this.#caretVisible;
      this.#paint();
    }, caretBlinkMs);
    this.#caretTimer.unref?.();
  }

  #stopCaretBlink() {
    if (this.#caretTimer) {
      clearInterval(this.#caretTimer);
      this.#caretTimer = undefined;
    }
    this.#caretVisible = true;
  }

  #showCaret() {
    this.#caretVisible = true;
  }

  #startTicker() {
    this.#clearTicker();
    this.#tickTimer = setInterval(() => {
      this.#spinnerIndex += 1;
      this.#paint();
    }, tickMs);
    this.#tickTimer.unref?.();
  }

  #stopTicker() {
    if (this.#hasLiveSessionActivity()) return;
    this.#clearTicker();
  }

  #clearTicker() {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = undefined;
    }
  }

  #hasLiveSessionActivity(): boolean {
    return this.#view?.working === true || this.#transcript.tasks.length > 0;
  }

  #taskPanelRows(width: number, maxRows = Math.max(8, Math.floor(this.#height() / 2))): string[] {
    const tasks = this.#transcript.tasks;
    if (tasks.length === 0) return [];
    const working = this.#view?.working === true && this.#flowlessStatus === undefined;
    const now = Date.now();
    const activity =
      working && this.#view !== undefined ? turnActivity(this.#view, tasks) : "Working";
    return renderTaskPanelRows(tasks, {
      width,
      theme: this.#theme,
      nowMs: now,
      maxRows,
      activity: activity.startsWith("Waiting for ") ? "Waiting" : activity,
      turnElapsedMs: working ? Math.max(0, now - (this.#turnClock.startedAtMs ?? now)) : undefined,
    });
  }

  #syncActivityTicker(): void {
    if (this.#hasLiveSessionActivity()) {
      if (this.#tickTimer === undefined) {
        this.#activityPulseStartedAtMs = Date.now();
        this.#startTicker();
      }
    } else if (
      this.#setupFlow === undefined &&
      this.#startupPhase === undefined &&
      this.#flowlessStatus === undefined
    ) {
      this.#clearTicker();
    }
  }

  #pushBlock(block: Block) {
    if (block.id !== this.#devRebuild?.id) this.#settleDevRebuildStatus();
    block.updateSeq = ++this.#updateSequence;
    this.#blocks.push(block);
    if (block.id) this.#blockById.set(block.id, block);
  }

  #commitTurnStats(): void {
    const settled = this.#turnClock.settle(this.#usage());
    if (settled === undefined) return;
    this.#lastTurnStats = settled;
    this.#diagnostics?.reportStats();

    if (
      settled.elapsedMs <= turnStatsMinDurationMs &&
      settled.inputTokens <= turnStatsMinInputTokens
    ) {
      return;
    }

    let body = `Done in ${this.#turnStatsBody(settled)}`;
    const contextTokens = this.#view?.data.lastStepUsage?.inputTokens ?? 0;
    if (this.#contextSize !== undefined && this.#contextSize > 0 && contextTokens > 0) {
      const fill = Math.round((contextTokens / this.#contextSize) * 100);
      body += ` ${this.#theme.glyph.dot} ${fill}% context`;
    }
    this.#pushBlock({ kind: "turn-stats", body, live: false });
  }

  #usage(): TokenUsage {
    return this.#view?.data.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  renderError(title: string, message: string): void {
    this.#start();
    this.#addErrorBlock(title, message);
  }

  #addErrorBlock(
    title: string,
    content: string,
    extras: { detail?: string | undefined; hint?: string | undefined } = {},
  ) {
    const cleanTitle = stripTerminalControls(title);
    const cleanBody = stripTerminalControls(content);
    const cleanDetail =
      extras.detail === undefined ? undefined : stripTerminalControls(extras.detail);
    const cleanHint = extras.hint === undefined ? undefined : stripTerminalControls(extras.hint);
    const entry = {
      source: "workflow" as const,
      summary: `${cleanTitle}: ${cleanBody}`,
      detail: cleanDetail ?? cleanBody,
    };
    this.#diagnostics?.append(cleanHint === undefined ? entry : { ...entry, hint: cleanHint });
    const block: Block = {
      kind: "error",
      title: cleanTitle,
      body: cleanBody,
      live: false,
    };
    if (cleanHint !== undefined) block.hint = cleanHint;
    if (cleanDetail !== undefined) {
      block.detail =
        this.#diagnostics === undefined ? cleanDetail : `details: ${this.#diagnostics.displayPath}`;
    }
    this.#pushBlock(block);
    this.#paint();
  }

  #upsertBlock(block: Block) {
    if (block.id && this.#committedIds.has(block.id)) {
      return;
    }
    const existing = block.id ? this.#blockById.get(block.id) : undefined;
    if (existing) {
      Object.assign(existing, block);
      existing.updateSeq = ++this.#updateSequence;
      return;
    }
    this.#pushBlock(block);
  }

  #removeBlock(id: string) {
    this.#blocks = this.#blocks.filter((candidate) => candidate.id !== id);
    this.#blockById.delete(id);
  }

  #paint() {
    if (!this.#isInteractive || this.#frameKept) return;
    if (this.#composerPending) {
      this.#paintDeferred = true;
      return;
    }

    if (this.#painting) {
      this.#paintAgain = true;
      return;
    }

    this.#painting = true;
    try {
      do {
        this.#paintAgain = false;
        this.#paintNow();
      } while (this.#paintAgain);
    } finally {
      this.#painting = false;
    }
  }

  #paintNow() {
    if (!this.#isInteractive) return;

    if (this.#traceView !== undefined) {
      this.#traceView.repaint();
      return;
    }

    const width = this.#width();
    const footer = this.#footerRows(width);
    const startupHeader =
      this.#startupHeader === undefined
        ? []
        : [
            ...this.#startupPreamble.map((row) => clip(row, width)),
            ...this.#renderAgentHeaderRows(),
          ];
    const maxBlockRows = Math.max(0, this.#height() - startupHeader.length - footer.length);
    const committed: string[] = this.#pendingCommittedRows.splice(0);
    let previous = this.#lastCommitted;

    const groups = groupToolBlocksForDisplay(this.#blocks);
    let settled = 0;
    while (settled < groups.length && groups[settled]!.display.live === false) settled += 1;

    if (settled > 0) {
      const committedMembers = new Set(groups.slice(0, settled).flatMap((group) => group.members));
      for (let i = this.#blocks.length - 1; i >= 0; i -= 1) {
        if (committedMembers.has(this.#blocks[i]!)) this.#blocks.splice(i, 1);
      }
    }
    for (const group of groups.slice(0, settled)) {
      for (const block of group.members) {
        this.#transcriptBlocks.push(block);
        if (block.id) {
          this.#committedIds.add(block.id);
          this.#blockById.delete(block.id);
        }
      }
      if (this.#isHiddenLog(group.display)) continue;
      const rows = this.#renderBlock(group.display, width, previous);
      previous = previousBlockOf(group.display);
      this.#lastCommitted = previous;
      committed.push(...rows);
      this.#committedTranscriptRows.push(...rows);
    }

    const flat: Array<{ block: Block; row: string }> = [];
    for (const { display: block } of groups.slice(settled)) {
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      for (let i = 0; i < rows.length; i += 1) {
        flat.push({ block, row: rows[i]! });
      }
    }

    const liveRows = [
      ...startupHeader,
      ...clipLiveRows(
        flat.map((entry) => entry.row),
        maxBlockRows,
        width,
        this.#theme,
      ),
      ...footer,
    ];
    if (committed.length > 0) {
      this.#live.flush(committed, liveRows);
    } else {
      this.#live.update(liveRows);
    }
  }

  #replayTranscript(): void {
    if (!this.#isInteractive) return;
    const width = this.#width();
    const footer = this.#footerRows(width);
    const maxBlockRows = Math.max(0, this.#height() - footer.length);
    let previous = this.#lastCommitted;
    const flat: string[] = [];

    for (const { display: block } of groupToolBlocksForDisplay(this.#blocks)) {
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      flat.push(...rows);
    }

    const liveRows = [...clipLiveRows(flat, maxBlockRows, width, this.#theme), ...footer];
    this.#live.clearAll();
    this.#live.flush(
      [...this.#renderAgentHeaderRows(), ...this.#committedTranscriptRows],
      liveRows,
    );
  }

  logDisplayMode(): LogDisplayMode {
    return this.#logs;
  }

  setLogDisplayMode(mode: LogDisplayMode): void {
    if (mode === this.#logs) return;
    this.#logs = mode;
    if (mode === "all") this.flushDelayedDevBuildErrors();
    this.#rebuildCommittedTranscript();
    if (this.#isInteractive) this.#replayTranscript();
  }

  flushDelayedDevBuildErrors(): void {
    const body = this.#delayedDevBuildError;
    if (body === undefined) return;
    this.#delayedDevBuildError = undefined;
    this.#pushBlock({ kind: "log", title: "stderr", logLevel: "error", body, live: false });
    this.#paint();
  }

  #cycleLogDisplayMode(): void {
    this.#logLevelHintActive = true;
    if (this.#logLevelHintTimer !== undefined) clearTimeout(this.#logLevelHintTimer);
    this.#logLevelHintTimer = setTimeout(() => {
      this.#logLevelHintActive = false;
      this.#logLevelHintTimer = undefined;
      this.#paint();
    }, logLevelHintMs);
    this.setLogDisplayMode(nextLogDisplayMode(this.#logs));
    this.#paint();
  }

  #rebuildCommittedTranscript(): void {
    const width = this.#width();
    this.#committedTranscriptRows.length = 0;
    let previous: PreviousBlock | undefined;
    for (const { display: block } of groupToolBlocksForDisplay(this.#transcriptBlocks, {
      logCoalescing: "runs",
    })) {
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      this.#committedTranscriptRows.push(...rows);
    }
    this.#lastCommitted = previous;
  }

  #renderAgentHeaderRows(): string[] {
    const header = this.#agentHeader;
    const startup = this.#startupHeader;
    if (header === undefined && startup === undefined) return [];
    const input: Parameters<typeof buildAgentHeader>[0] = {
      name: header?.name ?? startup?.name,
      theme: this.#theme,
      width: this.#width(),
    };
    if (header?.info !== undefined) input.info = header.info;
    return buildAgentHeader(input);
  }

  #renderBlock(block: DisplayBlock, width: number, previous: PreviousBlock | undefined): string[] {
    const context: Parameters<typeof renderBlockLines>[3] = {
      renderMarkdown: this.#renderMarkdown,
      activityPulse: this.#progressPulseGlyph(
        this.#activityPulseStartedAtMs,
        this.#theme.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      ),
    };
    if (previous !== undefined) context.previous = previous;
    if (this.#setupFlow !== undefined) context.setupFlowOpen = true;
    if (this.#transientPanel !== undefined) context.transientPanelOpen = true;
    const rows = renderBlockLines(block, width, this.#theme, context);
    if ((block.depth ?? 0) === 0 && leadsWithGap(block, previous)) {
      return ["", ...rows];
    }
    return rows;
  }

  #spinnerFrame(): string {
    return this.#theme.spinner[this.#spinnerIndex % this.#theme.spinner.length] ?? "";
  }

  #progressPulseGlyph(startedAtMs: number, glyph: string): string {
    return isProgressPulseVisible(Date.now() - startedAtMs) ? glyph : " ";
  }

  #setupFlowIndicator(flow: SetupFlowState): FlowPanelIndicator {
    return {
      glyph: this.#progressPulseGlyph(
        flow.startedAtMs,
        this.#theme.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      ),
    };
  }

  #footerRows(width: number): string[] {
    const c = this.#theme.colors;
    const rows: string[] = [""];

    if (this.#transientPanel !== undefined) {
      const drawer = this.#transientPanel(width);
      return [...drawer.rows, ...drawer.controls];
    }

    if (this.#hitlDrawer !== undefined) {
      const drawer = this.#hitlDrawer(width);
      const available = this.#height() - drawer.rows.length - drawer.controls.length - 1;
      const activity = available >= 4 ? this.#taskPanelRows(width, available + 1) : [];
      return [...activity.slice(0, -1), ...drawer.rows, ...drawer.controls].map((row) =>
        clip(row, width),
      );
    }

    const flow = this.#setupFlow;
    if (flow !== undefined && (this.#startupEditor === undefined || flow.question !== undefined)) {
      const indicator = this.#setupFlowIndicator(flow);
      let status: FlowPanelStatus | undefined;
      if (flow.status !== undefined) {
        const { startedAtMs, ...flowStatus } = flow.status;
        const elapsedMs = Date.now() - startedAtMs;
        const elapsed = elapsedMs >= 5_000 ? ` ${formatTurnDuration(elapsedMs)}` : "";
        status = { ...flowStatus, text: `${flowStatus.text}${elapsed}`, indicator };
      } else if (this.#startupPhase === "installing") {
        status = { text: "Installing dependencies…", indicator };
      }
      let content: FlowPanelContent;
      if (flow.question !== undefined) {
        const rows = flow.question(width);
        content = { kind: "question", title: flow.questionTitle, rows };
        if (status !== undefined) {
          content = { kind: "question", title: flow.questionTitle, rows, status };
        }
      } else if (status !== undefined) {
        content = { kind: "status", status };
        if (flow.preview !== undefined) {
          content = {
            kind: "status",
            status,
            preview: flow.preview,
          };
        }
      } else if (flow.preview !== undefined) {
        content = { kind: "preview", text: flow.preview, indicator };
      } else {
        content = { kind: "idle", indicator };
      }
      const state: Parameters<typeof renderFlowDrawer>[0] = {
        title: flow.title,
        navigation: flow.navigation,
        lines:
          flow.summary === undefined
            ? flow.hideLinesWhileQuestion === true
              ? []
              : flow.lines
            : [
                { text: flow.summary.headline, tone: "success" },
                ...flow.summary.facts.map((fact) => ({
                  text: `${fact.label}: ${fact.value}`,
                  tone: "info" as const,
                })),
              ],
        content,
      };
      const drawer = renderFlowDrawer(state, this.#theme, width);
      if (rows.length === 1 && rows[0] === "") rows.length = 0;
      rows.push(...drawer.rows);
      if (drawer.controls.length > 0) rows.push(...drawer.controls);
      this.#pushRemoteStatusLine(rows, width);
      return rows;
    }

    if (flow !== undefined) {
      rows.push(
        ...flowMessageRows(flow.lines, this.#theme).map((row) =>
          row.length === 0 ? "" : clip(` ${row}`, width),
        ),
      );
    }

    if (this.#startupPhase === undefined && this.#setupAttention !== undefined) {
      rows.push(...renderAttentionRows(this.#setupAttention, width, this.#theme), "");
    }

    const working = this.#view?.working === true && this.#flowlessStatus === undefined;
    const taskRows = this.#taskPanelRows(width);
    if (taskRows.length > 0) {
      rows.push(...taskRows);
    }

    const queueRows = renderMessageQueueRows({
      view: this.#startupQueue.view(),
      width,
      theme: this.#theme,
    });
    if (queueRows.length > 0) rows.push(...queueRows, "");

    if (working) {
      if (taskRows.length === 0) rows.push(this.#streamingTurnBar(width));
      if (this.#cancelRequested) {
        rows.push(
          clip(
            `${c.yellow(this.#theme.glyph.dotActive)} ${c.dim("Cancelling turn… · Ctrl+C to stop waiting, then again to exit")}`,
            width,
          ),
        );
      }
      if (taskRows.length === 0 || this.#cancelRequested) rows.push("");
    }

    if (this.#inputActive) {
      const inlineHint =
        this.#typeahead !== undefined ? inlineCommandHint(this.#typeahead) : undefined;
      const typeaheadRows = this.#typeaheadDrawerRows(width);
      if (this.#exitArmed) {
        rows.push(clip(c.dim("Press Ctrl+C again to exit"), width), "");
      }
      const ghost = inlineHint ? c.dim(` ${inlineHint}`) : "";
      const statusRows: string[] = [];
      this.#pushStatusLine(statusRows, width);
      const maxPromptRows = Math.max(
        1,
        this.#height() -
          1 -
          rows.length -
          1 -
          typeaheadRows.length -
          statusRows.length -
          (typeaheadRows.length > 0 ? 2 : 0),
      );
      const promptRows: Parameters<typeof promptInputRows>[0] = {
        text: this.#inputText,
        cursor: this.#inputCursor,
        width,
        theme: this.#theme,
        caretVisible: this.#caretVisible,
        ghost,
        maxRows: maxPromptRows,
      };
      if (this.#promptPlaceholderActive && this.#inputText.length === 0) {
        promptRows.placeholder =
          this.#startupEditor !== undefined
            ? "Message · Enter to queue"
            : this.#hasUserMessage || working
              ? ""
              : this.#initialPromptPlaceholder;
      }
      const renderedPromptRows = promptInputRows(promptRows);
      if (typeaheadRows.length > 0 && renderedPromptRows.at(-1) === "") renderedPromptRows.pop();
      rows.push(...renderedPromptRows);
      if (typeaheadRows.length > 0) rows.push(c.dim(this.#theme.glyph.dash.repeat(width)));
      rows.push(...typeaheadRows);
      if (typeaheadRows.length > 0 && statusRows.length > 0) {
        rows.push(c.dim(this.#theme.glyph.dash.repeat(width)));
      }
      rows.push(...statusRows);
      return rows;
    }

    if (working || this.#draft.text.length > 0) {
      this.#pushDraftPrompt(rows, width, { inert: working, adjacent: taskRows.length > 0 });
      this.#pushStatusLine(rows, width);
      return rows;
    }

    const statusText = this.#flowlessStatus ?? "Ready";
    const meta = this.#statusMeta();
    const icon = c.dim(this.#theme.glyph.dot);
    const line = meta
      ? `${icon} ${statusText}  ${c.dim(this.#theme.glyph.dot)}  ${meta}`
      : `${icon} ${statusText}`;
    rows.push(clip(line, width));
    this.#pushStatusLine(rows, width);
    return rows;
  }

  #streamingTurnBar(width: number): string {
    const c = this.#theme.colors;
    const startedAtMs = this.#turnClock.startedAtMs ?? Date.now();
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    const marker = elapsedMs % 1000 < 500 ? (this.#theme.unicode ? "•" : "*") : " ";
    const elapsed =
      elapsedMs < 1000 ? "0s" : formatTurnDuration(Math.floor(elapsedMs / 1000) * 1000);
    const activity =
      this.#view === undefined ? "Thinking" : turnActivity(this.#view, this.#transcript.tasks);
    const label = `${activity} (${elapsed})`;
    const { inputTokens, outputTokens } = this.#turnClock.usage(this.#usage());
    const tokens =
      inputTokens > 0 || outputTokens > 0
        ? c.dim(` (${formatTokenFlow({ inputTokens, outputTokens }, this.#theme.glyph)})`)
        : "";
    return clip(`${marker} ${label}${tokens}`, width);
  }

  #turnStatsBody(settled: { elapsedMs: number } & TokenUsage): string {
    const { inputTokens, outputTokens } = settled;
    const flow =
      inputTokens === 0 && outputTokens === 0
        ? ""
        : ` (${formatTokenFlow({ inputTokens, outputTokens }, this.#theme.glyph)})`;
    return `${formatTurnDuration(settled.elapsedMs)}${flow}`;
  }

  #pushDraftPrompt(
    rows: string[],
    width: number,
    options: { inert: boolean; adjacent?: boolean },
  ): void {
    if (!options.adjacent && rows.at(-1) !== "") rows.push("");
    const prompt: Parameters<typeof promptInputRows>[0] = {
      text: this.#draft.text,
      cursor: this.#draft.cursor,
      width,
      theme: this.#theme,
      caretVisible: true,
      ghost: "",
      maxRows: 4,
      inert: options.inert,
    };
    if (options.inert && this.#draft.text.length === 0) prompt.placeholder = "";
    rows.push(...promptInputRows(prompt));
  }

  #pushStatusLine(rows: string[], width: number): void {
    if (this.#startupPhase !== undefined) {
      const labels = {
        installing: "Installing dependencies…",
        starting: "Starting agent…",
        connecting: "Reading saved connection…",
        updating: "Loading selected model…",
      };
      const label = this.#setupFlow?.status?.text ?? labels[this.#startupPhase];
      const pulse = this.#progressPulseGlyph(
        this.#startupStartedAt,
        this.#theme.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      );
      rows.push(clip(this.#theme.colors.dim(`${pulse} ${label}`), width));
      return;
    }
    const padding = this.#remoteConnection === undefined ? "" : STATUS_LINE_LEFT_PADDING;
    const contentWidth = Math.max(1, width - padding.length);
    const input: Parameters<typeof buildStatusLine>[0] = {
      theme: this.#theme,
      width: contentWidth,
    };
    if (this.#devBuildStatusVisible && this.#devBuildStatus !== undefined) {
      input.devBuild = this.#devBuildStatus;
    }
    if (this.#logLevelHintActive) input.logLevel = this.#logs;
    const agentModel = this.#agentHeader?.info?.agent.model;
    if (agentModel?.routing.kind === "dynamic") {
      const modelId = this.#view?.data.modelId;
      input.dynamicModel = true;
      if (modelId !== undefined) input.model = modelId;
    } else if (agentModel?.id !== undefined) input.model = agentModel.id;
    if (agentModel?.reasoning !== undefined && agentModel.reasoning !== "provider-default") {
      input.reasoning = agentModel.reasoning;
    }
    if (readGatewayServiceTier(agentModel?.providerOptions).kind === "priority") {
      input.fastMode = true;
    }
    const endpoint = agentModel?.endpoint;
    if (endpoint !== undefined) input.endpoint = endpoint;
    if (this.#vercelStatus !== undefined) input.vercel = this.#vercelStatus;
    if (this.#remoteConnection !== undefined) input.remote = this.#remoteConnection;
    const line = buildStatusLine(input);
    if (line !== undefined) rows.push(clip(`${padding}${line}`, width));
  }

  #pushRemoteStatusLine(rows: string[], width: number): void {
    if (this.#remoteConnection === undefined) return;
    const contentWidth = Math.max(1, width - STATUS_LINE_LEFT_PADDING.length);
    const line = buildStatusLine({
      remote: this.#remoteConnection,
      theme: this.#theme,
      width: contentWidth,
    });
    if (line !== undefined) {
      rows.push("", clip(`${STATUS_LINE_LEFT_PADDING}${line}`, width));
    }
  }

  #statusMeta(): string {
    const c = this.#theme.colors;
    const parts: string[] = [];
    const turn = this.#lastTurnStats;
    const stats =
      turn === undefined
        ? undefined
        : formatAssistantResponseStats(
            {
              totalTokens: turn.inputTokens + turn.outputTokens,
              outputTokens: turn.outputTokens,
              tokensPerSecond:
                turn.elapsedMs > 0 ? turn.outputTokens / (turn.elapsedMs / 1000) : undefined,
            },
            this.#assistantResponseStats,
          );
    if (stats) parts.push(stats);
    return parts.length > 0 ? c.dim(parts.join(`  ${this.#theme.glyph.dot}  `)) : "";
  }

  #width(): number {
    return Math.max(20, this.#output.columns || 80);
  }

  #height(): number {
    return Math.max(8, this.#output.rows || 24);
  }

  #installLogCapture(): void {
    if (this.#restoreLogCapture !== undefined || !this.#captureForeignOutput) return;

    this.#stdoutLogBuffer = "";
    this.#stderrLogBuffer = "";

    const capture = (target: NodeJS.WriteStream, source: "stdout" | "stderr"): (() => void) => {
      const original = target.write.bind(target);
      target.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        this.#handleForeignOutput(source, chunkToString(chunk, encoding));
        done?.();
        return true;
      }) as typeof target.write;
      return () => {
        target.write = original;
      };
    };

    const consoleMethods = ["error", "warn", "log", "info", "debug"] as const;
    const originals = consoleMethods.map((method) => [method, console[method]] as const);
    for (const method of consoleMethods) {
      console[method] = (...args: unknown[]) =>
        this.#displayConsoleRecord({
          level: method === "log" ? "info" : method,
          text: format(...args),
        });
    }
    setConsoleRecordSubscriber((record) => this.#displayConsoleRecord(record));
    const restoreStdout = capture(process.stdout, "stdout");
    const restoreStderr = capture(process.stderr, "stderr");
    this.#diagnostics?.subscribeLogRecords((record) => this.#displayLogRecord(record));
    this.#restoreLogCapture = () => {
      this.#diagnostics?.unsubscribeLogRecords();
      setConsoleRecordSubscriber(undefined);
      for (const [method, original] of originals) console[method] = original;
      restoreStdout();
      restoreStderr();
    };
  }

  #removeLogCapture(): void {
    const restore = this.#restoreLogCapture;
    if (restore === undefined) return;
    this.#restoreLogCapture = undefined;
    restore();

    if (this.#stdoutLogBuffer.length > 0) {
      this.#diagnostics?.append({ source: "stdout", detail: this.#stdoutLogBuffer });
      if (this.#shouldRenderLog()) process.stdout.write(`${this.#stdoutLogBuffer}\n`);
      this.#stdoutLogBuffer = "";
    }
    if (this.#stderrLogBuffer.length > 0) {
      this.#diagnostics?.append({ source: "stderr", detail: this.#stderrLogBuffer });
      if (this.#shouldRenderLog()) process.stderr.write(`${this.#stderrLogBuffer}\n`);
      this.#stderrLogBuffer = "";
    }
  }

  #displayLogRecord(record: LogRecord): void {
    const fieldsText = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;
    this.#handleCapturedStderr(
      `[eve:${record.namespace}] ${record.message}${fieldsText}`,
      record.level,
    );
    this.#paint();
  }

  #displayConsoleRecord(record: ConsoleRecord): void {
    const source = record.level === "error" || record.level === "warn" ? "stderr" : "stdout";
    this.#diagnostics?.append({ source, level: record.level, detail: record.text });
    if (source === "stderr") this.#handleCapturedStderr(stripAnsi(record.text), record.level);
    else this.#handleCapturedStdout(stripAnsi(record.text), record.level);
    this.#paint();
  }

  #handleForeignOutput(source: "stdout" | "stderr", text: string): void {
    const combined = (source === "stdout" ? this.#stdoutLogBuffer : this.#stderrLogBuffer) + text;
    if (source === "stdout" && parseDevRebuildLogLine(combined.trimEnd()) !== undefined) {
      this.#stdoutLogBuffer = "";
      this.#diagnostics?.append({ source, detail: combined.trimEnd() });
      this.#handleCapturedStdout(combined.trimEnd());
      this.#paint();
      return;
    }
    const lastNewline = combined.lastIndexOf("\n");
    const remainder = lastNewline === -1 ? combined : combined.slice(lastNewline + 1);

    if (source === "stdout") {
      this.#stdoutLogBuffer = remainder;
    } else {
      this.#stderrLogBuffer = remainder;
    }

    if (lastNewline === -1) return;

    const content = stripAnsi(combined.slice(0, lastNewline)).replace(/\s+$/u, "");
    if (content.trim().length === 0) return;

    this.#diagnostics?.append({ source, detail: content });
    if (source === "stdout") this.#handleCapturedStdout(content);
    else this.#handleCapturedStderr(content);
    this.#paint();
  }

  #handleCapturedStdout(content: string, logLevel?: LogLevel): void {
    let pending: string[] = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      const body = pending.join("\n");
      pending = [];
      if (body.trim().length === 0) return;
      this.#pushBlock({ kind: "log", title: "stdout", logLevel, body, live: false });
    };

    for (const line of content.split("\n")) {
      const sandboxMessage = parseSandboxLogLine(line.trimEnd());
      if (sandboxMessage !== undefined) {
        flushPending();
        this.#pushBlock({ kind: "sandbox", logLevel, body: sandboxMessage, live: false });
        continue;
      }

      const update = parseDevRebuildLogLine(line.trimEnd());
      if (update === undefined) {
        pending.push(line);
        continue;
      }
      flushPending();
      this.#applyDevRebuildUpdate(update, line.trimEnd());
    }
    flushPending();
  }

  #handleCapturedStderr(content: string, logLevel?: LogLevel): void {
    const lines = content.split("\n");
    const failedIndex = lines.findIndex((line) => {
      return parseDevRebuildLogLine(line.trimEnd())?.kind === "failed";
    });
    if (failedIndex === -1) {
      if (this.#diagnostics === undefined) {
        this.#pushBlock({ kind: "log", title: "stderr", logLevel, body: content, live: false });
        return;
      }
      const presentation = presentDiagnostic(content, this.#diagnostics.displayPath);
      if (presentation.kind === "inline") {
        this.#pushBlock({
          kind: "log",
          title: "stderr",
          logLevel,
          body: presentation.text,
          live: false,
        });
        return;
      }
      this.#pushBlock({
        kind: "log",
        title: "stderr",
        body: formatStoredDiagnostic(presentation),
        logVisibility: "summary",
        logLevel,
        live: false,
      });
      this.#pushBlock({
        kind: "log",
        title: "stderr",
        body: content,
        logVisibility: "all-only",
        logLevel,
        live: false,
      });
      return;
    }

    const previous = lines.slice(0, failedIndex).join("\n");
    if (previous.trim().length > 0) {
      this.#pushBlock({ kind: "log", title: "stderr", logLevel, body: previous, live: false });
    }
    const failedBody = lines.slice(failedIndex).join("\n");
    this.#handleDevRebuildFailure(failedBody);
  }

  #handleDevRebuildFailure(body: string): void {
    this.#clearDevBuildStatus();
    if (this.#logs === "all") {
      if (body.trim().length === 0) return;
      this.#pushBlock({ kind: "log", title: "stderr", logLevel: "error", body, live: false });
      return;
    }
    this.#delayedDevBuildError = body;
  }

  #applyDevRebuildUpdate(update: DevRebuildLogUpdate, line: string): void {
    const cycle = this.#activeDevRebuildCycle();

    if (update.kind === "failed") {
      this.#handleDevRebuildFailure(line);
      return;
    }

    if (update.kind === "rebuilding") {
      const summary = summarizeChangedFiles(update.events, update.more);
      this.#setDevBuildStatus({ phase: "building", summary });
      if (cycle !== undefined) {
        cycle.state.summary = summary;
        cycle.block.body = formatDevRebuildStatus(summary, "rebuilding");
        return;
      }
      const id = `dev-rebuild:${this.#devRebuildSequence}`;
      this.#devRebuildSequence += 1;
      this.#devRebuild = { id, summary };
      this.#pushBlock({
        kind: "log",
        id,
        title: "stdout",
        body: formatDevRebuildStatus(summary, "rebuilding"),
        live: true,
      });
      return;
    }

    const summary = cycle?.state.summary ?? this.#devBuildStatus?.summary;
    if (summary !== undefined) this.#setDevBuildStatus({ phase: "complete", summary });
    if (cycle !== undefined) {
      cycle.block.body = formatDevRebuildStatus(cycle.state.summary, update.kind);
      if (update.kind === "rebuilt") this.#delayedDevBuildError = undefined;
      return;
    }
    if (update.kind === "rebuilt") this.#delayedDevBuildError = undefined;
    this.#pushBlock({ kind: "log", title: "stdout", body: line, live: false });
  }

  #setDevBuildStatus(status: DevBuildStatus): void {
    if (this.#devBuildStatusTimer !== undefined) clearTimeout(this.#devBuildStatusTimer);
    this.#devBuildStatus = status;
    this.#devBuildStatusVisible = status.phase === "complete";
    this.#devBuildStatusTimer = setTimeout(
      () => {
        if (status.phase === "building") {
          this.#devBuildStatusVisible = true;
          this.#devBuildStatusTimer = undefined;
        } else {
          this.#clearDevBuildStatus();
        }
        this.#paint();
      },
      status.phase === "building" ? devBuildProgressDelayMs : devBuildLoadedStatusMs,
    );
  }

  #clearDevBuildStatus(): void {
    if (this.#devBuildStatusTimer !== undefined) clearTimeout(this.#devBuildStatusTimer);
    this.#devBuildStatus = undefined;
    this.#devBuildStatusVisible = false;
    this.#devBuildStatusTimer = undefined;
  }

  #activeDevRebuildCycle(): { state: { id: string; summary: string }; block: Block } | undefined {
    const state = this.#devRebuild;
    if (state === undefined) return undefined;
    const block = this.#blockById.get(state.id);
    if (block === undefined || block.live !== true) return undefined;
    return { state, block };
  }

  #settleDevRebuildStatus(): void {
    const active = this.#devRebuild;
    if (active === undefined) return;
    this.#devRebuild = undefined;
    const block = this.#blockById.get(active.id);
    if (block !== undefined) block.live = false;
  }

  #shouldRenderLog(level?: LogLevel): boolean {
    return isLogVisible(this.#logs, level);
  }

  #isHiddenLog(block: Block): boolean {
    if (block.kind === "sandbox") return !this.#shouldRenderLog(block.logLevel);
    if (block.kind !== "log") return false;
    if (block.logVisibility === "summary" && this.#logs === "all") return true;
    if (block.logVisibility === "all-only") return this.#logs !== "all";
    return !this.#shouldRenderLog(block.logLevel);
  }
}

function chunkToString(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}

function clip(line: string, width: number): string {
  return clipVisible(line, width);
}

interface PromptInputRowsInput {
  readonly text: string;
  readonly cursor: number;
  readonly width: number;
  readonly theme: Theme;
  readonly caretVisible: boolean;
  readonly ghost: string;
  readonly maxRows: number;
  placeholder?: string;
  inert?: boolean;
}

function promptInputRows({
  text,
  cursor,
  width,
  theme,
  caretVisible,
  ghost,
  maxRows,
  placeholder,
  inert,
}: PromptInputRowsInput): string[] {
  const c = theme.colors;

  if (text.length === 0 && placeholder !== undefined) {
    const body = renderInputWithBlockCursor({
      ...visibleLine(
        { text: placeholder, cursor: 0 },
        Math.max(1, width - 3),
        theme.glyph.ellipsis,
      ),
      visible: caretVisible,
      inverse: c.inverse,
      render: (segment) => c.dim(renderInputText(segment)),
    });
    return [clip(`${theme.glyph.prompt} ${body}`, width), ""];
  }

  const style = renderInputText;

  const layout = layoutPromptInput({ text, cursor });
  const visibleCount = Math.min(Math.max(1, maxRows), layout.rows.length);
  const top = Math.max(
    0,
    Math.min(layout.caretRow - visibleCount + 1, layout.rows.length - visibleCount),
  );
  const promptGlyph =
    inert === true
      ? c.dim(theme.glyph.prompt)
      : text.startsWith("/")
        ? theme.glyph.user
        : theme.glyph.prompt;
  const ellipsis = c.dim(theme.glyph.ellipsis);
  const budget = Math.max(1, width - 3);
  const out: string[] = [];
  for (let r = top; r < top + visibleCount; r += 1) {
    const row = layout.rows[r]!;
    let gutter = r === 0 ? promptGlyph : " ";
    if (r === top && top > 0) gutter = ellipsis;
    else if (r === top + visibleCount - 1 && top + visibleCount < layout.rows.length) {
      gutter = ellipsis;
    }

    let body: string;
    if (r === layout.caretRow) {
      const { before, under, after } = visibleLine(
        { text: row.text, cursor: layout.caretOffset },
        budget,
        theme.glyph.ellipsis,
      );
      body = renderInputWithBlockCursor({
        before,
        under,
        after,
        visible: caretVisible,
        inverse: c.inverse,
        render: style,
      });
      if (ghost.length > 0 && layout.rows.length === 1) body += ghost;
    } else {
      body = style(row.text);
    }
    out.push(clip(`${gutter} ${body}`, width));
  }
  out.push("");
  return out;
}

type PreviousBlock = { kind: BlockKind; title?: string; subagentCallId?: string };

function previousBlockOf(block: Block): PreviousBlock {
  const previous: PreviousBlock = { kind: block.kind };
  if (block.title !== undefined) previous.title = block.title;
  if (block.subagentCallId !== undefined) previous.subagentCallId = block.subagentCallId;
  return previous;
}

function leadsWithGap(block: Block, previous: PreviousBlock | undefined): boolean {
  if (
    (block.kind === "tool" || block.kind === "task") &&
    (previous?.kind === "user" || previous?.kind === "assistant" || previous?.kind === "question")
  ) {
    return true;
  }
  if (block.kind === "sandbox" && previous?.kind === "sandbox") {
    return false;
  }
  if (previous?.kind === "sandbox" && block.kind !== "sandbox") return true;
  if (previous?.kind === "log") return true;
  switch (block.kind) {
    case "user":
    case "assistant":
    case "reasoning":
    case "error":
    case "notice":
    case "question":
    case "connection-auth":
    case "sandbox":
    case "log":
    case "command":
    case "warning":
    case "flow":
    case "turn-stats":
    case "session-boundary":
    case "agent-header":
      return true;
    default:
      return false;
  }
}

function parseSandboxLogLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("eve: ")) {
    return undefined;
  }

  const message = trimmed.slice("eve: ".length);
  return /\bsandbox\b/i.test(message) && !isLowValueSandboxLogLine(message) ? message : undefined;
}

function isLowValueSandboxLogLine(message: string): boolean {
  return (
    /^initializing (?:\d+ )?sandbox templates?\b/i.test(message) ||
    /^initialized \d+ sandbox\b/i.test(message) ||
    /^reused cached sandbox template\b/i.test(message) ||
    /^sandbox template "[^"]+" \([^)]+\): (checking|reusing)\b/i.test(message)
  );
}

function clipLiveRows(
  rows: readonly string[],
  maxRows: number,
  width: number,
  theme: Theme,
): string[] {
  if (maxRows <= 0) return [];
  if (rows.length <= maxRows) return [...rows];
  if (maxRows <= 1) {
    return [clip(hiddenRowsMarker(rows.length, theme), width)];
  }

  const visibleTailCount = maxRows - 1;
  const hidden = rows.length - visibleTailCount;
  return [
    clip(hiddenRowsMarker(hidden, theme), width),
    ...rows.slice(rows.length - visibleTailCount),
  ];
}

function hiddenRowsMarker(hidden: number, theme: Theme): string {
  const count = hidden.toLocaleString();
  const noun = hidden === 1 ? "row" : "rows";
  return theme.colors.dim(
    `${theme.glyph.dot} ${theme.glyph.ellipsis} ${count} earlier ${noun} hidden while streaming`,
  );
}

function questionSectionId(requestId: string): string {
  return `question:${requestId}`;
}

function resolveQuestionText(
  rawText: string,
  question: AgentTUIInputQuestion,
): { optionId?: string; text?: string; label: string } | undefined {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return undefined;

  const normalized = trimmed.toLowerCase();
  const options = question.options ?? [];

  if (options.length > 0) {
    const matched = matchQuestionOption(normalized, options);
    if (matched !== undefined) return { optionId: matched.id, label: matched.label };
  }

  const acceptsFreeform = question.allowFreeform === true || options.length === 0;
  if (acceptsFreeform) return { text: trimmed, label: trimmed };
  return undefined;
}

function matchQuestionOption(
  normalized: string,
  options: ReadonlyArray<AgentTUIInputOption>,
): AgentTUIInputOption | undefined {
  const byId = options.find((option) => option.id.toLowerCase() === normalized);
  if (byId !== undefined) return byId;
  const byLabel = options.find((option) => option.label.toLowerCase() === normalized);
  if (byLabel !== undefined) return byLabel;
  const numericIndex = Number(normalized);
  if (Number.isInteger(numericIndex) && numericIndex > 0 && numericIndex <= options.length) {
    return options[numericIndex - 1];
  }
  return undefined;
}
