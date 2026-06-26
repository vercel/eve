import { StringDecoder } from "node:string_decoder";

import type {
  AgentTUIInputOption,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIRenderer,
  AgentTUISessionOptions,
  AgentTUIStreamEvent,
  AgentTUIStreamUsage,
  AgentTUIStreamResult,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
  ConnectionAuthUpdate,
  SubagentStepUpdate,
  SubagentToolUpdate,
} from "./runner.js";
import { interruptedError } from "./errors.js";
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
  PROMPT_COMMANDS,
  type PromptCommandSpec,
} from "./prompt-commands.js";
import {
  renderFlowPanel,
  renderAcknowledgeQuestion,
  renderSelectQuestion,
  renderTextQuestion,
  type FlowPanelContent,
  type FlowPanelIndicator,
  type FlowPanelLine,
  type SetupPanelOption,
  type SetupSelectPanelState,
} from "./setup-panel.js";
import type {
  SetupEditableSelectResult,
  SetupFlowIndicator,
  SetupFlowRenderer,
  SetupSelectRequest,
} from "./setup-flow.js";
import type { SelectNotice } from "#setup/prompter.js";
import type { ProviderPickerChoice, ProviderPickerRequest } from "#setup/flows/provider.js";
import {
  initialSelectState,
  reduceSelect,
  searchActionQuery,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import { renderCursorRow } from "#setup/cli/option-row.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "./types.js";
import type { AgentInfoResult } from "#client/index.js";
import {
  parseDevRebuildLogLine,
  type DevRebuildLogUpdate,
} from "#internal/nitro/host/dev-watcher-log.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  type Block,
  type BlockKind,
  type ToolStatus,
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
import {
  EMPTY_LINE,
  PromptHistory,
  applyLineEditorKey,
  deleteForward,
  layoutPromptInput,
  lineOf,
  movePromptLine,
  visibleLine,
  type LineState,
} from "./line-editor.js";
import { LiveRegion } from "./live-region.js";
import { buildStatusLine } from "./status-line.js";
import { nextLogDisplayMode } from "./log-display-mode.js";
import { createTheme, detectUnicode, type Theme } from "./theme.js";
import {
  clipVisible,
  renderInputText,
  renderInputWithBlockCursor,
  stripAnsi,
  stripTerminalControls,
} from "./terminal-text.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import { summarizeToolArgs, summarizeToolResult } from "./tool-format.js";
import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";
import {
  isProgressPulseVisible,
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_GLYPH,
} from "#cli/ui/progress-pulse.js";
import {
  formatAssistantResponseStats,
  formatTokenFlow,
  isIncompletePaste,
  nextKey,
  sanitizePastedText,
  stripPasteStart,
  stripPromptControlCharacters,
  takeUntil,
  type TerminalKey,
} from "./stream-format.js";

type SetupOptionPanelState = Exclude<SetupSelectPanelState, { kind: "actions" }>;

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

function completedTurnStatus(interrupted: boolean, continueSession: boolean): string {
  if (interrupted) return "Interrupted";
  if (continueSession) return "Ready";
  return "Done";
}

type SetupFlowIndicatorState = { kind: "spinner" } | { kind: "pulse"; startedAtMs: number };

type TurnIndicatorState =
  | { kind: "idle" }
  | { kind: "waiting"; startedAtMs: number }
  | { kind: "answering" };

type SetupFlowState = {
  title: string;
  indicator: SetupFlowIndicatorState;
  lines: FlowPanelLine[];
  status?: string;
  /** Latest subprocess output line; replaced per write, never persisted. */
  preview?: string;
  /** Recent subprocess output, flushed as context when a warning settles it. */
  outputBuffer: string[];
  question?: (width: number) => string[];
  /** First line produced after the previous task-list question settled. */
  taskListLineStart?: number;
  /** Task-list questions render their latest outcomes inside the question. */
  hideLinesWhileQuestion?: boolean;
};

/**
 * How much subprocess output a warning or error can pull in as its evidence.
 * Only the one-line preview is ever painted while the command runs, so the
 * cap costs nothing visually — it bounds how much of a failure's tail (e.g.
 * a `vercel deploy` build error) survives the settle.
 */
const FLOW_OUTPUT_BUFFER_CAP = 40;
const STATUS_LINE_LEFT_PADDING = "  ";

const defaultAssistantResponseStats: AssistantResponseStatsMode = "tokensPerSecond";

export type TerminalRendererOptions = {
  input?: TerminalInput;
  output?: TerminalOutput;
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  connectionAuth?: TerminalPartDisplayMode;
  assistantResponseStats?: AssistantResponseStatsMode;
  contextSize?: number;
  captureForeignOutput?: boolean;
  logs?: LogDisplayMode;
  color?: boolean;
  unicode?: boolean;
  /** Slash commands available in this local or remote session. */
  availablePromptCommands?: readonly PromptCommandSpec[];
};

export type AgentHeaderOptions = {
  name: string;
  serverUrl: string;
  info?: AgentInfoResult;
  /** Message-of-the-day line under the brand line (local sessions only). */
  tip?: string;
};

type DisplayModes = {
  tools: TerminalPartDisplayMode;
  reasoning: TerminalPartDisplayMode;
  assistantResponseStats: AssistantResponseStatsMode;
};

type RenderTurnState = {
  text: Map<string, string>;
  reasoning: Map<string, string>;
  tools: Map<string, NativeToolState>;
  hasPendingToolResults: boolean;
};

type NativeToolState = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
  errorText?: string;
};

const caretBlinkMs = 500;
const tickMs = 90;
const TURN_PULSE_GLYPH = "⊙";
const TURN_PULSE_ASCII_GLYPH = "o";
// How long to wait on a lone `ESC` before treating it as the Escape key, so a
// split arrow sequence (`ESC` then `[A`) has time to reassemble first.
const escFlushMs = 30;
// How long to wait, with no further input, before abandoning a bracketed paste
// whose closing marker never arrived. Generous because the timer resets on every
// read, so an in-flight paste keeps it alive; it only fires once input goes quiet.
const incompletePasteFlushMs = 1_000;
// How long the transient Ctrl+L log-mode hint stays in the status line after
// the last cycle before it clears itself.
const logLevelHintMs = 5_000;

const STATUS = {
  processing: "Working…",
  toolResults: "Reading results…",
  streaming: "Responding…",
  executingTools: "Running tools…",
  connectionAuth: "Waiting for connection authorization…",
} as const;

export class TerminalRenderer implements AgentTUIRenderer {
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;
  readonly #live: LiveRegion;
  readonly #theme: Theme;
  readonly #tools: TerminalPartDisplayMode;
  readonly #reasoning: TerminalPartDisplayMode;
  readonly #subagents: TerminalPartDisplayMode;
  readonly #connectionAuth: TerminalPartDisplayMode;
  readonly #assistantResponseStats: AssistantResponseStatsMode;
  readonly #defaultContextSize?: number;
  readonly #captureForeignOutput: boolean;
  readonly #availablePromptCommands: readonly PromptCommandSpec[];
  /** Which captured log sources render. Mutable via {@link setLogDisplayMode}. */
  #logs: LogDisplayMode;

  /** Live (uncommitted) blocks, in transcript order. */
  #blocks: Block[] = [];
  readonly #blockById = new Map<string, Block>();
  /** Section ids already committed to scrollback — never re-rendered. */
  readonly #committedIds = new Set<string>();
  /**
   * Every committed block, in transcript order — including log blocks the
   * current {@link LogDisplayMode} filters out. Committed *rows* are
   * rendered under one specific log filter; this block history is what lets
   * a `/loglevel` change re-render the whole committed transcript, hiding
   * or restoring past log lines at their original positions.
   */
  readonly #transcriptBlocks: Block[] = [];

  readonly #childToolCallIds = new Set<string>();
  readonly #parentToolBlockIds = new Map<string, string>();
  readonly #subagentHeaders = new Set<string>();
  #agentHeader?: AgentHeaderOptions;
  #agentHeaderRendered = false;
  /** The last committed header body, to skip re-committing an unchanged banner. */
  #agentHeaderBody?: string;
  /**
   * Committed transcript rows as rendered under the current log filter.
   * Replayed wholesale when a `/loglevel` change re-renders the committed
   * transcript from {@link #transcriptBlocks}.
   */
  readonly #committedTranscriptRows: string[] = [];

  /**
   * Kind and title of the last block committed to scrollback. Seeds the
   * inter-block gap and log-run-continuation decisions for the next paint,
   * so spacing stays stable as blocks move from the live region into
   * scrollback.
   */
  #lastCommitted?: PreviousBlock;

  #connectionAuthPendingCount = 0;
  /** Vercel segment of the bottom status line; pushed by the runner. */
  #vercelStatus?: VercelStatusSnapshot;
  /** Remote target and connection/authentication state; pushed by the runner. */
  #remoteConnection?: RemoteConnectionSnapshot;
  #inputText = "";
  #inputCursor = 0;
  readonly #promptHistory = new PromptHistory();
  #inputActive = false;
  /**
   * Command suggestions for the prompt draft. Only `readPrompt` sets this —
   * `readInputQuestion` shares `#inputActive` and the footer's input row, and
   * a `/`-prefixed freeform answer must never sprout suggestions.
   */
  #typeahead?: CommandTypeaheadState;
  #turnIndicator: TurnIndicatorState = { kind: "idle" };
  #status: string = STATUS.processing;
  #title = "eve";
  #isInteractive = false;
  #interrupted = false;
  #caretVisible = true;
  #spinnerIndex = 0;
  #caretTimer?: ReturnType<typeof setInterval>;
  #tickTimer?: ReturnType<typeof setInterval>;
  #logLevelHintTimer?: ReturnType<typeof setTimeout>;
  /** Whether the transient Ctrl+L log-mode hint is currently shown. */
  #logLevelHintActive = false;
  /** Active per-mode key consumer (prompt, approval, question, streaming). */
  #consumeKey?: (key: TerminalKey) => void;
  /** Decoded input held while an escape sequence is still arriving. */
  #keyBuffer = "";
  #inputDecoder = new StringDecoder("utf8");
  #keyFlushTimer?: ReturnType<typeof setTimeout>;
  #onResize?: () => void;
  #resolveStreamInterrupt?: () => void;
  #painting = false;
  #paintAgain = false;

  #totalTokens?: number;
  /** Input (prompt) tokens from the latest usage report — the ↑ side. */
  #promptTokens?: number;
  #contextSize?: number;
  #assistantOutputTokens?: number;
  #assistantTokensPerSecond?: number;
  /** Wall-clock start of the current stream, for the tok/s status stat. */
  #streamStartedAt?: number;

  #restoreLogCapture?: () => void;
  #stdoutLogBuffer = "";
  #stderrLogBuffer = "";
  #delayedDevBuildError?: string;
  /**
   * The in-place dev rebuild status line. While the dev server's rebuild log
   * lines are the newest transcript content, they all cycle through this one
   * live block — only the latest state shows. Any other block pushed behind
   * it settles the cycle: the status line finalizes, commits to scrollback as
   * an ordinary log block, and the next rebuild line opens a fresh cycle.
   */
  #devRebuild?: { id: string; summary: string };
  /** Monotonic id source — committed cycle ids must never be reused. */
  #devRebuildSequence = 0;
  #pendingEchoedPrompt?: string;
  /** The active setup flow's bordered panel: progress, question, status. */
  #setupFlow?: SetupFlowState;
  /** The clearable setup attention line (`⚠ … · /vc:login`), rendered in the live footer. */
  #setupAttention?: string;
  /** Armed by {@link SetupFlowRenderer.waitForInterrupt}; fired by the idle key trap. */
  #flowInterrupt?: () => void;
  /** The installed working-state key consumer, so re-arming and disposal can recognize it. */
  #flowIdleConsumer?: (key: TerminalKey) => void;
  readonly setupFlow: SetupFlowRenderer = {
    begin: (title, indicator) => this.#beginSetupFlow(title, indicator),
    end: (options) => this.#endSetupFlow(options?.preserveDiagnostics ?? true),
    readSelect: (options) => this.#readSetupSelect(options),
    readEditableSelect: (options) => this.#readSetupEditableSelect(options),
    readProviderPicker: (options) => this.#readProviderPicker(options),
    readText: (options) => this.#readSetupText(options),
    readAcknowledge: (options) => this.#readSetupAcknowledge(options),
    readChoice: (options) => this.#readSetupChoice(options),
    setStatus: (text) => this.#setFlowStatus(text),
    renderLine: (text, tone) => this.#renderFlowLine(text, tone),
    renderOutput: (text) => this.#renderFlowOutput(text),
    waitForInterrupt: () => this.#waitForFlowInterrupt(),
  };

  constructor(options?: TerminalRendererOptions) {
    this.#input = options?.input ?? process.stdin;
    this.#output = options?.output ?? process.stdout;
    // Bind the live region to the output's ORIGINAL `write` (captured here at
    // construction, before `#installLogCapture` monkeypatches it). Otherwise
    // every frame the live region paints would be intercepted as foreign log
    // output and re-trigger a paint — unbounded recursion.
    this.#live = new LiveRegion(this.#output);
    this.#theme = createTheme({
      color: options?.color ?? true,
      unicode: options?.unicode ?? detectUnicode(),
    });
    this.#tools = options?.tools ?? "auto-collapsed";
    this.#reasoning = options?.reasoning ?? "full";
    this.#subagents = options?.subagents ?? "auto-collapsed";
    this.#connectionAuth = options?.connectionAuth ?? "full";
    this.#assistantResponseStats = options?.assistantResponseStats ?? defaultAssistantResponseStats;
    this.#defaultContextSize = options?.contextSize;
    this.#contextSize = options?.contextSize;
    this.#captureForeignOutput = options?.captureForeignOutput ?? this.#output === process.stdout;
    this.#logs = options?.logs ?? "none";
    this.#availablePromptCommands = options?.availablePromptCommands ?? PROMPT_COMMANDS;
  }

  /**
   * Commits the startup agent header (brand mark + resolved configuration) to
   * scrollback before the first prompt. Later calls (dev HMR refreshing fields
   * such as the agent name) commit a fresh header beneath the existing
   * transcript only when the rendered header actually changed — every source
   * reload re-sends it, and an identical banner repeated per reload is noise.
   * Committed scrollback is never cleared or replayed.
   */
  renderAgentHeader(options: AgentHeaderOptions): void {
    this.#title = options.name;
    this.#agentHeader = options;
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
    // Commit the header to scrollback with no footer; the first `readPrompt`
    // paints the input line beneath it. Startup intentionally preserves the
    // user's existing scrollback instead of clearing the terminal.
    this.#live.flush(this.#renderAgentHeaderRows(), []);
  }

  async readPrompt(options?: AgentTUISessionOptions): Promise<string> {
    this.#start(options);
    this.#stopTicker();
    this.#inputActive = true;
    this.#turnIndicator = { kind: "idle" };
    this.#status = "";
    let editor: LineState = lineOf(stripPromptControlCharacters(options?.initialDraft ?? ""));
    this.#promptHistory.begin(editor.text);
    this.#syncInput(editor);
    this.#typeahead = typeaheadFor(this.#availablePromptCommands, editor.text);
    this.#startCaretBlink();
    this.#paint();

    return await new Promise((resolve, reject) => {
      const apply = (next: LineState) => {
        editor = next;
        this.#showCaret();
        this.#syncInput(editor);
        this.#typeahead = typeaheadFor(this.#availablePromptCommands, next.text, this.#typeahead);
        this.#paint();
      };
      const recall = (entry: string | undefined) => {
        if (entry !== undefined) apply(lineOf(entry));
      };
      const interrupt = () => {
        this.#typeahead = undefined;
        this.#stopCaretBlink();
        this.#stop();
        reject(interruptedError());
      };
      const suggestions = () =>
        this.#typeahead !== undefined && isTypeaheadOpen(this.#typeahead)
          ? this.#typeahead
          : undefined;
      const highlighted = () => {
        const open = suggestions();
        return open === undefined ? undefined : selectedTypeaheadCommand(open);
      };

      this.#consumeKey = (key) => {
        // Chat keeps pasted newlines and honors Shift+Enter. Setup-panel inputs
        // stay single-line; freeform questions opt in separately below.
        const edited = applyLineEditorKey(editor, key, { multiline: true });
        if (edited !== undefined) {
          apply(edited);
          return;
        }
        switch (key.type) {
          case "up": {
            const open = suggestions();
            if (open !== undefined) {
              this.#typeahead = moveTypeaheadSelection(open, -1);
              this.#paint();
              break;
            }
            // Within a multi-line buffer, ↑ walks to the row above; only at the
            // top row does it hand off to prompt history.
            const moved = movePromptLine(editor, "up");
            if (moved !== undefined) apply(moved);
            else recall(this.#promptHistory.previous(editor.text));
            break;
          }
          case "down": {
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
            const selected = highlighted();
            if (selected !== undefined) apply(lineOf(typeaheadCompletion(selected)));
            break;
          }
          case "escape": {
            const open = suggestions();
            if (open !== undefined) {
              this.#typeahead = dismissTypeahead(open);
              this.#paint();
            }
            break;
          }
          case "enter": {
            const selected = highlighted();
            // Complete only genuine prefixes: a draft that already parses
            // (exact name, alias, or argument form) submits verbatim, so
            // /quit echoes as the user typed it.
            const prompt =
              selected !== undefined && parsePromptCommand(editor.text) === null
                ? typeaheadCompletion(selected).trimEnd()
                : editor.text;
            this.#typeahead = undefined;
            this.#promptHistory.add(prompt);
            this.#inputActive = false;
            this.#stopCaretBlink();
            this.#startWorking();
            this.#status = STATUS.processing;
            if (isPromptControlCommand(prompt)) {
              // Commands echo as their own line (blue, under the prompt
              // glyph) so the elbow-connected outcome has an invocation to
              // hang under — never as a user chat message.
              this.#pushBlock({
                kind: "command",
                body: stripTerminalControls(prompt.trim()),
                live: false,
              });
            } else {
              this.#addUserBlock(prompt);
              this.#pendingEchoedPrompt = prompt;
            }
            this.#syncInput(EMPTY_LINE);
            this.#paint();
            this.#detachInput();
            resolve(prompt);
            break;
          }
          case "ctrl-d":
            // EOF on an empty line quits; otherwise it forward-deletes.
            if (editor.text.length === 0) {
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
            // A first Ctrl+C clears a non-empty prompt; on an already-empty
            // prompt it quits.
            if (editor.text.length === 0) {
              interrupt();
            } else {
              apply(EMPTY_LINE);
            }
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  #syncInput(state: LineState): void {
    this.#inputText = state.text;
    this.#inputCursor = state.cursor;
  }

  async renderStream(
    result: AgentTUIStreamResult,
    options?: AgentTUISessionOptions,
  ): Promise<void> {
    this.#start(options);
    // Stream event ids are stable only within one streamed turn. Fresh
    // sessions in tests and dev can reuse tool call / turn ids, so committed
    // ids from prior turns must not suppress the next prompt's blocks.
    this.#committedIds.clear();
    this.#inputActive = false;
    if (this.#turnIndicator.kind !== "waiting") {
      this.#turnIndicator = { kind: "waiting", startedAtMs: Date.now() };
    }
    this.#status = STATUS.processing;
    this.#addSubmittedPrompt(options?.submittedPrompt);
    this.#interrupted = false;
    this.#totalTokens = undefined;
    this.#promptTokens = undefined;
    this.#assistantOutputTokens = undefined;
    this.#assistantTokensPerSecond = undefined;
    this.#streamStartedAt = Date.now();
    const displayModes: DisplayModes = {
      tools: options?.tools ?? this.#tools,
      reasoning: options?.reasoning ?? this.#reasoning,
      assistantResponseStats: options?.assistantResponseStats ?? this.#assistantResponseStats,
    };
    this.#startTicker();
    this.#paint();

    const streamInterrupted = new Promise<void>((resolve) => {
      this.#resolveStreamInterrupt = resolve;
    });
    this.#consumeKey = (key) => this.#handleStreamingKey(key);
    this.#attachInput();
    const turnState: RenderTurnState = {
      text: new Map(),
      reasoning: new Map(),
      tools: new Map(),
      hasPendingToolResults: false,
    };

    try {
      for await (const event of takeUntil(iterateTUIStream(result.events), streamInterrupted)) {
        if (this.#interrupted) break;
        this.#applyStreamEvent(event, displayModes, turnState);
      }
    } catch (error) {
      this.#addErrorBlock("Error", toErrorMessage(error));
    } finally {
      this.#resolveStreamInterrupt = undefined;
      if (this.#interrupted) result.abort?.();
      this.#detachInput();
      this.#stopTicker();
      if (this.#turnIndicator.kind === "waiting") {
        this.#turnIndicator = { kind: "idle" };
      }
      this.#status = completedTurnStatus(this.#interrupted, options?.continueSession === true);
      this.#finalizeAllBlocks();
      this.#paint();

      if (!options?.continueSession) {
        this.#stop();
      }
    }
  }

  async readToolApproval(
    request: AgentTUIToolApprovalRequest,
    options?: AgentTUISessionOptions,
  ): Promise<AgentTUIToolApprovalResponse> {
    this.#start(options);
    this.#stopTicker();
    this.#inputActive = false;
    this.#turnIndicator = { kind: "idle" };
    this.#status = `Approve ${formatToolApprovalTitle(request)}?  (y/n)`;
    this.#interrupted = false;
    this.#paint();

    return await new Promise((resolve, reject) => {
      this.#consumeKey = (key) => {
        switch (key.type) {
          case "text": {
            // This prevents ordinary bracketed paste from confirming by
            // accident; terminal framing is not an authentication signal.
            if (key.framing !== "unframed") break;
            const value = key.value.toLowerCase();
            if (value === "y") {
              this.#startWorking();
              this.#status = STATUS.processing;
              this.#detachInput();
              this.#paint();
              resolve({ approved: true });
            } else if (value === "n") {
              this.#startWorking();
              this.#status = STATUS.processing;
              this.#markToolDenied(request.toolCallId);
              this.#detachInput();
              this.#paint();
              resolve({ approved: false, reason: "Denied by user." });
            }
            break;
          }
          case "ctrl-r":
            this.#paint();
            break;
          case "ctrl-c":
            this.#interrupted = true;
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
    this.#stopTicker();
    this.#inputActive = false;
    this.#turnIndicator = { kind: "idle" };
    this.#interrupted = false;

    const optionList = question.options ?? [];
    const hasOptions = optionList.length > 0;
    const allowFreeform = question.allowFreeform === true || !hasOptions;
    const hasFreeformRow = allowFreeform && hasOptions;
    const totalRows = optionList.length + (hasFreeformRow ? 1 : 0);
    const sectionKey = questionSectionId(question.requestId);

    let mode: "select" | "text" = hasOptions ? "select" : "text";
    let cursorIndex = 0;
    let editor = EMPTY_LINE;

    const isOnFreeformRow = () => hasFreeformRow && cursorIndex === optionList.length;

    const renderSection = () => {
      this.#upsertBlock({
        id: sectionKey,
        kind: "question",
        title: stripTerminalControls(question.prompt),
        body: formatQuestionContent(question, cursorIndex, this.#theme),
        preformatted: true,
        live: true,
      });
    };

    const repaintStatus = () => {
      if (mode === "select") {
        const confirm = isOnFreeformRow() ? "type" : "select";
        this.#status = `↑/↓ move · enter ${confirm} · Ctrl+C quit`;
        this.#inputActive = false;
      } else {
        this.#inputActive = true;
        this.#syncInput(editor);
        this.#status = "";
      }
      this.#paint();
    };

    renderSection();
    if (mode === "text") this.#startCaretBlink();
    repaintStatus();

    const finalize = (resolved: {
      optionId?: string;
      text?: string;
      label: string;
    }): AgentTUIInputQuestionResponse => {
      this.#upsertBlock({
        id: sectionKey,
        kind: "question",
        title: stripTerminalControls(question.prompt),
        body: `  ${this.#theme.colors.green(this.#theme.glyph.success)} ${stripTerminalControls(resolved.label)}`,
        preformatted: true,
        live: false,
      });
      this.#inputActive = false;
      this.#startWorking();
      this.#status = STATUS.processing;
      this.#stopCaretBlink();
      this.#detachInput();
      this.#paint();
      const response: AgentTUIInputQuestionResponse = {};
      if (resolved.optionId !== undefined) response.optionId = resolved.optionId;
      if (resolved.text !== undefined) response.text = resolved.text;
      return response;
    };

    return await new Promise<AgentTUIInputQuestionResponse | undefined>((resolve, reject) => {
      this.#consumeKey = (key) => {
        if (key.type === "ctrl-c") {
          if (mode === "text" && editor.text.length > 0) {
            editor = EMPTY_LINE;
            this.#showCaret();
            repaintStatus();
            return;
          }
          this.#interrupted = true;
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
          switch (key.type) {
            case "up":
              if (totalRows > 0) {
                cursorIndex = (cursorIndex - 1 + totalRows) % totalRows;
                renderSection();
                repaintStatus();
              }
              break;
            case "down":
              if (totalRows > 0) {
                cursorIndex = (cursorIndex + 1) % totalRows;
                renderSection();
                repaintStatus();
              }
              break;
            case "enter": {
              if (isOnFreeformRow()) {
                mode = "text";
                editor = EMPTY_LINE;
                this.#startCaretBlink();
                repaintStatus();
                break;
              }
              const option = optionList[cursorIndex];
              if (option) resolve(finalize({ optionId: option.id, label: option.label }));
              break;
            }
            default:
              break;
          }
          return;
        }

        const edited = applyLineEditorKey(editor, key, { multiline: true });
        if (edited !== undefined) {
          editor = edited;
          this.#showCaret();
          repaintStatus();
          return;
        }

        switch (key.type) {
          case "up":
          case "down": {
            const moved = movePromptLine(editor, key.type);
            if (moved !== undefined) {
              editor = moved;
              this.#showCaret();
              repaintStatus();
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
            if (hasOptions) {
              if (editor.text.length > 0) {
                editor = EMPTY_LINE;
                this.#showCaret();
                repaintStatus();
                break;
              }
              mode = "select";
              editor = EMPTY_LINE;
              this.#inputActive = false;
              this.#stopCaretBlink();
              repaintStatus();
              break;
            }
            editor = EMPTY_LINE;
            this.#showCaret();
            repaintStatus();
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  upsertSubagentStep(update: SubagentStepUpdate): void {
    if (this.#subagents === "hidden") return;
    const reasoningText = stripTerminalControls(update.reasoning ?? "").trim();
    const messageText = stripTerminalControls(update.message ?? "").trim();
    if (reasoningText.length === 0 && messageText.length === 0) return;

    this.#ensureSubagentHeader(update.callId, update.subagentName);
    if (this.#subagents === "collapsed") {
      this.#paint();
      return;
    }

    this.#upsertBlock({
      id: subagentStepSectionId(update.callId, update.sectionKey),
      kind: "subagent-step",
      depth: 1,
      reasoning: reasoningText,
      body: messageText,
      live: !update.finalized,
    });
    this.#paint();
  }

  upsertSubagentTool(update: SubagentToolUpdate): void {
    if (this.#subagents === "hidden") return;
    this.#ensureSubagentHeader(update.callId, update.subagentName);
    if (this.#subagents === "collapsed") {
      this.#paint();
      return;
    }

    const status = subagentToolStatus(update.status);
    const block: Block = {
      id: subagentToolSectionId(update.callId, update.childCallId),
      kind: "subagent-tool",
      depth: 1,
      title: stripTerminalControls(update.toolName),
      subtitle: summarizeToolArgs(update.input),
      status,
      live: status === "running" || status === "approval",
      expanded: this.#subagents === "full",
      toolInput: update.input,
    };
    if (update.output !== undefined) {
      block.result = summarizeToolResult(update.output);
      block.toolOutput = update.output;
    } else if (update.errorText !== undefined) {
      block.result = stripTerminalControls(update.errorText);
    }
    this.#upsertBlock(block);
    this.#paint();
  }

  markChildToolCallId(callId: string): void {
    this.#childToolCallIds.add(callId);
    const staleId = this.#parentToolBlockIds.get(callId);
    if (staleId === undefined) return;
    this.#removeBlock(staleId);
    this.#parentToolBlockIds.delete(callId);
    this.#paint();
  }

  /**
   * Flips the tool block for a denied approval to its terminal `denied`
   * state. Called at the moment the user answers `n` — the server never
   * executes the call, so no `action.result` will arrive to settle it.
   */
  #markToolDenied(toolCallId: string): void {
    const block = this.#blockById.get(toolSectionId(toolCallId));
    if (block === undefined) return;
    block.status = "denied";
    block.live = false;
  }

  upsertConnectionAuth(update: ConnectionAuthUpdate): void {
    if (this.#connectionAuth === "hidden") return;
    const isTerminal =
      update.state === "authorized" ||
      update.state === "declined" ||
      update.state === "failed" ||
      update.state === "timed-out";
    this.#upsertBlock({
      id: connectionAuthSectionId(update.name),
      kind: "connection-auth",
      title: `${stripTerminalControls(update.name)} · authorization · ${update.state}`,
      body: formatConnectionAuthContent(update),
      preformatted: true,
      live: !isTerminal,
    });
    this.#paint();
  }

  setConnectionAuthPendingCount(count: number): void {
    const next = Math.max(0, count);
    if (next === this.#connectionAuthPendingCount) return;
    const wasPending = this.#connectionAuthPendingCount > 0;
    this.#connectionAuthPendingCount = next;
    if (next > 0) {
      this.#status = STATUS.connectionAuth;
      this.#paint();
    } else if (wasPending) {
      this.#status = STATUS.processing;
      this.#paint();
    }
  }

  setVercelStatus(status: VercelStatusSnapshot): void {
    this.#vercelStatus = status;
    // #paint self-guards on #isInteractive, so a probe resolving after
    // shutdown is inert.
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
    // `/new` resets the conversation, not the workspace: keep #agentHeader
    // (the status line's model segment reads it — the header is not re-sent
    // after a reset) and #vercelStatus (link + pending-deploy outlive the
    // conversation). The header *block* still leaves the transcript because
    // its rows are only re-emitted via renderAgentHeader.
    this.#agentHeaderRendered = false;
    this.#agentHeaderBody = undefined;
    this.#childToolCallIds.clear();
    this.#parentToolBlockIds.clear();
    this.#subagentHeaders.clear();
    this.#pendingEchoedPrompt = undefined;
    this.#devRebuild = undefined;
    this.#connectionAuthPendingCount = 0;
    this.#totalTokens = undefined;
    this.#promptTokens = undefined;
    this.#assistantOutputTokens = undefined;
    this.#assistantTokensPerSecond = undefined;
    this.#streamStartedAt = undefined;
    if (this.#isInteractive) {
      this.#live.clearAll();
      this.#paint();
    }
  }

  /**
   * Commits a single dim informational line to the transcript (e.g. the
   * session-recovery notice after a terminal server failure). No-op when the
   * text is blank.
   */
  renderNotice(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#start();
    this.#pushBlock({ kind: "notice", body: content, live: false });
    this.#paint();
  }

  renderSandboxLog(text: string): void {
    const content = stripTerminalControls(text);
    const sandboxMessage = parseSandboxLogLine(content);
    if (sandboxMessage === undefined) return;
    this.#start();
    this.#pushBlock({ kind: "sandbox", body: sandboxMessage, live: false });
    this.#paint();
  }

  /**
   * Sets the setup attention line (yellow `⚠`, commands blue) as a live footer
   * element above the prompt. Unlike committed scrollback, it can be cleared:
   * once the underlying issue is fixed (e.g. `/vc:login` succeeds) the runner calls
   * {@link clearSetupWarning} and the line disappears rather than lingering
   * stale in the transcript.
   */
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

  /** Removes the setup attention line once its issue is resolved. */
  clearSetupWarning(): void {
    this.#clearSetupAttention();
  }

  #clearSetupAttention(): void {
    if (this.#setupAttention === undefined) return;
    this.#setupAttention = undefined;
    this.#paint();
  }

  /** Commits a slash-command invocation that was started without prompt input. */
  renderCommandInvocation(text: string, status?: "failed"): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#start();
    const block: Block = {
      kind: "command",
      body: content,
      live: false,
    };
    if (status === "failed") block.status = "error";
    this.#pushBlock(block);
    this.#paint();
  }

  /**
   * Commits one command's outcome under its invocation with the elbow
   * connector (` ⎿  /model cancelled.`), Claude Code's sub-result grammar.
   */
  renderCommandResult(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#start();
    this.#pushBlock({ kind: "result", body: content, live: false });
    this.#paint();
  }

  /**
   * Opens the bordered flow panel for one setup command. Until the flow ends,
   * every flow line, question, and status renders inside it; the transcript
   * above stays untouched.
   */
  #beginSetupFlow(title: string, indicator: SetupFlowIndicator = "spinner"): void {
    this.#start();
    this.#inputActive = false;
    this.#turnIndicator = { kind: "idle" };
    this.#status = "";
    const indicatorState: SetupFlowIndicatorState =
      indicator === "pulse" ? { kind: "pulse", startedAtMs: Date.now() } : { kind: "spinner" };
    this.#setupFlow = {
      title: stripTerminalControls(title),
      indicator: indicatorState,
      lines: [],
      outputBuffer: [],
    };
    // The ticker runs for the whole flow: the idle pulse, the status indicator,
    // and the output preview all animate through it.
    this.#startTicker();
    this.#paint();
  }

  /**
   * Closes the flow panel, optionally retaining its warning/error diagnostics.
   * A diagnostic's pulled-in subprocess evidence persists with it, as one dim
   * block directly above — a failed command must keep its evidence past the
   * panel (the deploy box's rail contract), not just its exit-code summary.
   */
  #endSetupFlow(preserveDiagnostics: boolean): void {
    this.#flowInterrupt = undefined;
    this.#disarmFlowIdleTrap();
    const flow = this.#setupFlow;
    if (flow === undefined) return;
    this.#setupFlow = undefined;
    this.#stopTicker();

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
        // Evidence binds only to the diagnostic that settled it; any other
        // line in between orphans it.
        evidence = [];
      }
    }
    this.#paint();
  }

  /**
   * Asks one select question inside the flow panel. Behavior comes from the
   * shared select reducer (filter, cursor, toggle, locked rows, the
   * multi-select Submit row). Resolves the chosen value keys, or `undefined`
   * when the user cancels with Ctrl-C or Esc from an unfiltered list. Esc
   * clears an active search first. One question at a time; it vanishes on
   * resolve.
   */
  async #readSetupSelect(opts: SetupSelectRequest): Promise<readonly string[] | undefined> {
    const flow = this.#beginSetupQuestion();
    const multiple = isMultiSelectRequest(opts);
    const searchAction = opts.kind === "search" ? opts.searchAction : undefined;
    let selectOptions: readonly SetupPanelOption[] = opts.options;

    const initial: Parameters<typeof initialSelectState>[0] = {
      options: selectOptions,
      searchAction,
      submitRow: multiple,
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
          submitRow: multiple,
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
          ...initialSelectState({ options, searchAction, submitRow: multiple }),
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
    if (opts.kind === "task-list") {
      const start = flow.taskListLineStart ?? flow.lines.length;
      const outcomes: SelectNotice[] = flow.lines
        .slice(start)
        .filter(
          (line): line is FlowPanelLine & { tone: "success" | "warning" | "error" } =>
            line.tone === "success" || line.tone === "warning" || line.tone === "error",
        )
        .map((line) => ({ tone: line.tone, text: line.text }));
      notices = [...(opts.notices ?? []), ...outcomes];
      flow.taskListLineStart = flow.lines.length;
      flow.hideLinesWhileQuestion = true;
    }
    const panelState = (): SetupOptionPanelState => {
      const state: SetupOptionPanelState = { ...opts, options: selectOptions, select };
      if (notices !== undefined && notices.length > 0) state.notices = notices;
      if (error !== undefined) state.error = error;
      if (loading) state.loadingFrame = this.#spinnerFrame();
      return state;
    };
    flow.question = (width) => renderSelectQuestion(panelState(), this.#theme, width);
    this.#paint();

    const question = this.#captureSetupQuestion<readonly string[] | undefined>((key, settle) => {
      const close = (value: readonly string[] | undefined): void => {
        searchVersion += 1;
        settle(value);
      };
      if (loading) {
        if (key.type === "ctrl-c") close(undefined);
        else if (key.type === "escape") clearSearch();
        else if (key.type === "ctrl-r") this.#paint();
        return;
      }

      const base = { key, options: selectOptions, searchAction, select };
      const result = multiple
        ? reduceSetupSelectInput({ ...base, kind: opts.kind, required: opts.required })
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
    });
    return await question.promise;
  }

  /**
   * An inert context row followed by a separate action menu beside the live flow
   * spinner. Unlike {@link #readSetupSelect} it keeps the spinner running (the
   * poll is still in flight) and returns synchronously with a `close()` so the
   * caller can dismiss it the moment the poll wins the race.
   */
  #readSetupChoice(
    opts: Parameters<SetupFlowRenderer["readChoice"]>[0],
  ): ReturnType<SetupFlowRenderer["readChoice"]> {
    this.#start();
    const flow = this.#requireSetupFlow();
    flow.status = opts.status;
    // No action is pre-selected: the user must move into the action group before
    // Enter can act, rather than firing "Try again" by reflex.
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
        const intent = setupSelectionIntent(key);
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
    const flow = this.#beginSetupQuestion();

    const initial: Parameters<typeof initialSelectState>[0] = { options: opts.options };
    if (opts.initialValue !== undefined) initial.defaultValue = opts.initialValue;
    let select = initialSelectState(initial);
    let editor = lineOf("");
    let error: string | undefined;

    flow.question = (width) => {
      const state: SetupSelectPanelState = {
        kind: "inline-edit",
        layout: "task-list",
        message: opts.message,
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
    // Hovering the editable row makes it a live field. The editor stays empty
    // until typing starts, leaving the default as a placeholder with the caret
    // at its start. Moving off the row clears the field and stops the blink.
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

        const intent = setupSelectionIntent(key);
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
        const edited = applyLineEditorKey(editor, key);
        if (edited !== undefined) applyEditor(edited);
      },
      () => this.#stopCaretBlink(),
    );
    return await question.promise;
  }

  async #readProviderPicker(
    opts: ProviderPickerRequest,
  ): Promise<ProviderPickerChoice | undefined> {
    const flow = this.#beginSetupQuestion();
    let interaction = initialProviderPickerState(opts.options, opts.initialValue);
    let validation: AbortController | undefined;

    flow.question = (width) =>
      renderSelectQuestion(
        {
          kind: "inline-edit",
          layout: "stacked",
          message: opts.message,
          options: opts.options,
          select: interaction.select,
          edit: {
            optionValue: "own-key",
            caretVisible: this.#caretVisible,
            editor: { kind: "key", phase: interaction.phase },
          },
        },
        this.#theme,
        width,
      );

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

        const intent = setupSelectionIntent(key);
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

  /**
   * Asks one text question through the bordered setup panel. `mask` renders
   * bullets (passwords); `validate` paints its message red inside the panel
   * and keeps the prompt open. Resolves the submitted value (the default when
   * submitted empty), or `undefined` on Esc/Ctrl-C.
   */
  async #readSetupText(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
    notices?: readonly SelectNotice[];
  }): Promise<string | undefined> {
    const flow = this.#beginSetupQuestion();

    let editor: LineState = lineOf("");
    let error: string | undefined;

    flow.question = (width) => {
      const state: Parameters<typeof renderTextQuestion>[0] = {
        message: opts.message,
        editor,
        mask: opts.mask === true,
      };
      if (opts.placeholder !== undefined) state.placeholder = opts.placeholder;
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

        const edited = applyLineEditorKey(editor, key);
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

  /**
   * Holds a static acknowledgement section in the flow panel until the user
   * dismisses it. Enter and Esc both resolve — the text is the point; there
   * is nothing to cancel, so this never returns a cancellation.
   */
  async #readSetupAcknowledge(opts: { message: string; lines: readonly string[] }): Promise<void> {
    const flow = this.#beginSetupQuestion();

    flow.question = (width) =>
      renderAcknowledgeQuestion({ message: opts.message, lines: opts.lines }, this.#theme, width);
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

  /** Enters the common inactive-input state owned by an open setup question. */
  #beginSetupQuestion(): SetupFlowState {
    this.#start();
    this.#inputActive = false;
    this.#turnIndicator = { kind: "idle" };
    this.#status = "";
    return this.#requireSetupFlow();
  }

  /** A flow is implicitly opened for a bare question (tests, future hosts). */
  #requireSetupFlow(): SetupFlowState {
    if (this.#setupFlow === undefined) {
      this.#setupFlow = {
        title: "",
        indicator: { kind: "spinner" },
        lines: [],
        outputBuffer: [],
      };
    }
    return this.#setupFlow;
  }

  #closeSetupQuestion(): void {
    if (this.#setupFlow !== undefined) {
      this.#setupFlow.question = undefined;
      this.#setupFlow.hideLinesWhileQuestion = false;
    }
    this.#consumeKey = undefined;
    this.#detachInput();
    // Back to the working state: the interrupt trap covers the gap until the
    // next question (or the flow's end).
    this.#armFlowIdleTrap();
    this.#paint();
  }

  /**
   * Gives one setup question exclusive key ownership and a settle-once close
   * function. Question-specific reducers stay with their callers; this owns
   * only the repeated input attachment and panel teardown lifecycle.
   */
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
    this.#consumeKey = (key) => consume(key, settle, reject);
    this.#attachInput();
    return { promise, settle };
  }

  /** See {@link SetupFlowRenderer.waitForInterrupt}. */
  #waitForFlowInterrupt(): { promise: Promise<void>; dispose(): void } {
    let fire!: () => void;
    const promise = new Promise<void>((resolve) => {
      fire = resolve;
    });
    this.#flowInterrupt = fire;
    this.#armFlowIdleTrap();
    return {
      promise,
      dispose: () => {
        if (this.#flowInterrupt !== fire) return;
        this.#flowInterrupt = undefined;
        this.#disarmFlowIdleTrap();
      },
    };
  }

  /**
   * Installs the working-state key consumer (Ctrl-C/Esc fires the armed flow
   * interrupt) while no question owns the keys. Questions overwrite
   * `#consumeKey` for their lifetime; {@link #closeSetupQuestion} re-arms.
   */
  #armFlowIdleTrap(): void {
    if (this.#flowInterrupt === undefined) return;
    const consumer = (key: TerminalKey): void => {
      if (key.type === "ctrl-c" || key.type === "escape") {
        const fire = this.#flowInterrupt;
        this.#flowInterrupt = undefined;
        this.#disarmFlowIdleTrap();
        fire?.();
        return;
      }
      if (key.type === "ctrl-r") this.#paint();
    };
    this.#flowIdleConsumer = consumer;
    this.#consumeKey = consumer;
    this.#attachInput();
  }

  /** Removes the idle trap without touching a question's key consumer. */
  #disarmFlowIdleTrap(): void {
    if (this.#flowIdleConsumer === undefined) return;
    if (this.#consumeKey === this.#flowIdleConsumer) {
      this.#detachInput();
    }
    this.#flowIdleConsumer = undefined;
  }

  /**
   * The flow's ephemeral one-line loading state: a message turns the footer
   * status into the working indicator; `undefined` clears it. Nothing is ever
   * committed to the transcript.
   */
  #setFlowStatus(text: string | undefined): void {
    const content = text === undefined ? undefined : stripTerminalControls(text);
    if (this.#setupFlow !== undefined) {
      this.#setupFlow.status = content;
      if (content === undefined) this.#setupFlow.preview = undefined;
      this.#paint();
      return;
    }
    if (content === undefined) {
      this.#turnIndicator = { kind: "idle" };
      this.#status = "";
      this.#stopTicker();
      this.#paint();
      return;
    }
    this.#start();
    this.#startWorking();
    this.#status = content;
    this.#paint();
  }

  /**
   * Commits one persistent flow line to the transcript (progress the user
   * must keep, like the Slack Connect URL), toned info/success/warning/error.
   */
  #renderFlowLine(text: string, tone: "info" | "success" | "warning" | "error"): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#setupFlow;
    if (flow !== undefined) {
      // A line settles the output preview (the rail-log contract): it clears,
      // and a warning or error first pulls the buffered subprocess output in
      // as context — a failed command must keep its evidence.
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

  /**
   * One line of subprocess output during a flow: shown as the transient
   * preview (replaced per write), buffered so a settling warning can pull
   * recent context in, never persisted on its own. Outside a flow it falls
   * back to a dim transcript line.
   */
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

  shutdown(): void {
    this.#stop();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  #start(options?: AgentTUISessionOptions) {
    this.#title = options?.title ?? this.#title;
    this.#contextSize = options?.contextSize ?? this.#defaultContextSize;

    if (this.#isInteractive) return;

    this.#isInteractive = true;
    this.#live.reset();
    this.#live.hideCursor();
    this.#installLogCapture();

    if (this.#input.isTTY) {
      this.#input.setRawMode?.(true);
      this.#input.resume();
      // Enable bracketed paste (DEC private mode 2004) so the terminal wraps
      // pasted text in \x1b[200~ … \x1b[201~; the decoder then inserts a
      // multi-line paste intact instead of each newline submitting the prompt.
      // Routed through the live region's original `write` so the foreign-output
      // capture installed just above can't swallow the control sequence.
      this.#live.emitBracketedPaste(true);
    }

    this.#onResize = () => this.#paint();
    this.#output.on("resize", this.#onResize);
  }

  #stop() {
    this.#detachInput();
    this.#stopCaretBlink();
    this.#stopTicker();
    if (this.#logLevelHintTimer !== undefined) {
      clearTimeout(this.#logLevelHintTimer);
      this.#logLevelHintTimer = undefined;
    }
    this.#logLevelHintActive = false;

    if (!this.#isInteractive) return;

    // Commit any leading finalized blocks (e.g. freshly captured log lines)
    // before the live region is wiped, so they land in scrollback instead of
    // vanishing with the repaint area. The in-place rebuild status settles
    // first so its last state survives as scrollback too.
    this.#settleDevRebuildStatus();
    this.#paint();

    this.#live.clear();
    this.#live.showCursor();
    // Restore the real `process.stdout` before the trailing newline so it is
    // not intercepted by the foreign-output capture.
    this.#removeLogCapture();
    this.#live.newline();

    if (this.#input.isTTY) {
      // Disable bracketed paste, restoring the terminal to how we found it.
      this.#live.emitBracketedPaste(false);
      this.#input.setRawMode?.(false);
      this.#input.pause();
    }

    if (this.#onResize) {
      this.#output.off("resize", this.#onResize);
      this.#onResize = undefined;
    }

    this.#isInteractive = false;
  }

  #attachInput() {
    // Idempotent: the flow idle trap and questions both attach; a double
    // subscription would deliver every key twice.
    this.#input.off("data", this.#feedRaw);
    this.#input.on("data", this.#feedRaw);
  }

  #detachInput() {
    this.#input.off("data", this.#feedRaw);
    this.#clearKeyFlush();
    this.#keyBuffer = "";
    this.#inputDecoder = new StringDecoder("utf8");
    this.#consumeKey = undefined;
  }

  /**
   * Buffers raw input and decodes it into keys, reassembling escape sequences
   * that arrive split across reads. A lone trailing `ESC` is held briefly (see
   * {@link escFlushMs}) in case it is the start of an arrow/function key.
   */
  readonly #feedRaw = (chunk: Buffer) => {
    this.#clearKeyFlush();
    this.#keyBuffer += this.#inputDecoder.write(chunk);
    this.#drainKeys();
    this.#armKeyFlush();
  };

  /**
   * Arms a one-shot timer for an escape sequence that {@link nextKey} can't yet
   * resolve, so the decoder never blocks all further input waiting on bytes that
   * will not come. Re-armed on every read, so a sequence still in flight stays
   * alive; it only fires once input goes quiet.
   */
  #armKeyFlush() {
    // A lone trailing ESC may begin an arrow/function key; hold it briefly, then
    // surface it as a bare Escape. This is the standard ESC-timeout heuristic: a
    // lone ESC and the leading byte of a longer sequence are indistinguishable,
    // so a paste whose `\x1b[200~` leader is split off by >escFlushMs (only under
    // network/PTY fragmentation, never an atomically-delivered local paste) can
    // be misread as Escape + literal text. Lengthening the timeout trades Escape
    // latency for a smaller window; not worth it for a non-adversarial edge.
    if (this.#keyBuffer === "\x1b") {
      this.#keyFlushTimer = setTimeout(() => {
        if (this.#keyBuffer !== "\x1b") return;
        this.#keyBuffer = "";
        this.#consumeKey?.({ type: "escape" });
      }, escFlushMs);
      this.#keyFlushTimer.unref?.();
      return;
    }
    // A bracketed paste whose closing marker never arrives would otherwise wedge
    // input forever. Recover its sanitized payload without losing the paste
    // framing that downstream consumers use to apply paste-safe behavior.
    if (isIncompletePaste(this.#keyBuffer)) {
      const stuck = this.#keyBuffer;
      this.#keyFlushTimer = setTimeout(() => {
        if (this.#keyBuffer !== stuck) return;
        const value = sanitizePastedText(stripPasteStart(stuck));
        this.#keyBuffer = "";
        if (value.length > 0) {
          this.#consumeKey?.({ type: "text", value, framing: "bracketed-paste" });
        }
      }, incompletePasteFlushMs);
      this.#keyFlushTimer.unref?.();
    }
  }

  #drainKeys() {
    while (this.#keyBuffer.length > 0) {
      const token = nextKey(this.#keyBuffer);
      if (token.incomplete) return;
      this.#keyBuffer = this.#keyBuffer.slice(token.consumed);
      if (token.key && token.key.type !== "ignore") this.#consumeKey?.(token.key);
    }
  }

  #clearKeyFlush() {
    if (this.#keyFlushTimer) {
      clearTimeout(this.#keyFlushTimer);
      this.#keyFlushTimer = undefined;
    }
  }

  #handleStreamingKey(key: TerminalKey) {
    switch (key.type) {
      case "ctrl-l":
      case "ctrl-r":
        this.#paint();
        break;
      case "ctrl-c":
        if (!this.#interrupted) {
          this.#interrupted = true;
          this.#turnIndicator = { kind: "idle" };
          this.#status = "Interrupted";
          this.#resolveStreamInterrupt?.();
          this.#paint();
        }
        break;
      default:
        break;
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
    this.#stopTicker();
    this.#tickTimer = setInterval(() => {
      this.#spinnerIndex += 1;
      this.#paint();
    }, tickMs);
    this.#tickTimer.unref?.();
  }

  #startWorking(): void {
    this.#turnIndicator = { kind: "waiting", startedAtMs: Date.now() };
    this.#startTicker();
  }

  #stopTicker() {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Block management
  // ---------------------------------------------------------------------------

  /**
   * Appends a new block to the transcript. Any block other than the active
   * dev rebuild status line settles that line first — the in-place cycle only
   * runs while rebuild updates are the newest transcript content.
   */
  #pushBlock(block: Block) {
    if (block.id !== this.#devRebuild?.id) this.#settleDevRebuildStatus();
    this.#blocks.push(block);
    if (block.id) this.#blockById.set(block.id, block);
  }

  #addUserBlock(prompt: string) {
    this.#pushBlock({ kind: "user", body: stripTerminalControls(prompt), live: false });
    this.#paint();
  }

  #addSubmittedPrompt(prompt: string | undefined) {
    if (prompt == null) return;
    if (this.#pendingEchoedPrompt === prompt) {
      this.#pendingEchoedPrompt = undefined;
      return;
    }
    this.#pushBlock({ kind: "user", body: stripTerminalControls(prompt), live: false });
  }

  #addErrorBlock(title: string, content: string, detail?: string) {
    const block: Block = {
      kind: "error",
      title: stripTerminalControls(title),
      body: stripTerminalControls(content),
      live: false,
    };
    if (detail !== undefined) block.detail = stripTerminalControls(detail);
    this.#pushBlock(block);
    this.#paint();
  }

  #ensureSubagentHeader(callId: string, name: string) {
    if (this.#subagentHeaders.has(callId)) return;
    this.#subagentHeaders.add(callId);
    this.#pushBlock({
      id: subagentHeaderId(callId),
      kind: "subagent",
      title: stripTerminalControls(name),
      live: false,
    });
  }

  #upsertBlock(block: Block) {
    if (block.id && this.#committedIds.has(block.id)) {
      return;
    }
    const existing = block.id ? this.#blockById.get(block.id) : undefined;
    if (existing) {
      Object.assign(existing, block);
      return;
    }
    this.#pushBlock(block);
  }

  #removeBlock(id: string) {
    this.#blocks = this.#blocks.filter((candidate) => candidate.id !== id);
    this.#blockById.delete(id);
  }

  #finalizeAllBlocks() {
    for (const block of this.#blocks) {
      // Blocks awaiting an approval decision or action.result stay live past
      // the end of the stream. Committing them here would freeze the pending
      // glyph into scrollback before the later decision/result can settle it.
      if (block.status === "approval" || block.status === "running") continue;
      block.live = false;
    }
  }

  #applyStreamEvent(
    event: AgentTUIStreamEvent,
    displayModes: DisplayModes,
    turnState: RenderTurnState,
  ): void {
    switch (event.type) {
      case "step-start":
        this.#setStreamStatus(
          turnState.hasPendingToolResults ? STATUS.toolResults : STATUS.processing,
        );
        turnState.hasPendingToolResults = false;
        break;

      case "step-finish":
        this.#applyUsage(event.usage);
        this.#paint();
        break;

      case "assistant-delta": {
        const text = (turnState.text.get(event.id) ?? "") + stripTerminalControls(event.delta);
        this.#showAnswerContent(text);
        this.#setStreamStatus(STATUS.streaming);
        turnState.text.set(event.id, text);
        this.#upsertAssistantBlock(event.id, text, true);
        break;
      }

      case "assistant-complete": {
        const existing = turnState.text.get(event.id) ?? "";
        const text =
          event.text !== undefined && existing.length === 0
            ? stripTerminalControls(event.text ?? "")
            : existing;
        this.#showAnswerContent(text);
        turnState.text.set(event.id, text);
        this.#upsertAssistantBlock(event.id, text, false);
        break;
      }

      case "reasoning-delta": {
        if (displayModes.reasoning === "hidden") break;
        const text = (turnState.reasoning.get(event.id) ?? "") + stripTerminalControls(event.delta);
        this.#showAnswerContent(text);
        this.#setStreamStatus(STATUS.streaming);
        turnState.reasoning.set(event.id, text);
        this.#upsertReasoningBlock(event.id, text, true, displayModes);
        break;
      }

      case "reasoning-complete": {
        if (displayModes.reasoning === "hidden") break;
        const text = turnState.reasoning.get(event.id) ?? "";
        this.#showAnswerContent(text);
        this.#upsertReasoningBlock(event.id, text, false, displayModes);
        break;
      }

      case "tool-call":
        if (displayModes.tools === "hidden") break;
        this.#setStreamStatus(STATUS.executingTools);
        this.#upsertNativeTool(
          {
            input: event.input,
            status: "running",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
          displayModes,
          turnState,
        );
        break;

      case "tool-approval-request": {
        if (displayModes.tools === "hidden") break;
        const existing = turnState.tools.get(event.toolCallId);
        if (existing === undefined) break;
        this.#upsertNativeTool({ ...existing, status: "approval" }, displayModes, turnState);
        break;
      }

      case "tool-result": {
        if (displayModes.tools === "hidden") break;
        const existing = this.#resolveNativeToolState(event.toolCallId, turnState);
        if (existing === undefined) break;
        turnState.hasPendingToolResults = true;
        this.#setStreamStatus(STATUS.toolResults);
        this.#upsertNativeTool(
          { ...existing, output: event.output, status: "done" },
          displayModes,
          turnState,
        );
        break;
      }

      case "tool-error": {
        if (displayModes.tools === "hidden") break;
        const existing = this.#resolveNativeToolState(event.toolCallId, turnState);
        if (existing === undefined) break;
        turnState.hasPendingToolResults = true;
        this.#setStreamStatus(STATUS.toolResults);
        this.#upsertNativeTool(
          { ...existing, errorText: event.errorText, status: "error" },
          displayModes,
          turnState,
        );
        break;
      }

      case "error":
        this.#addErrorBlock("Error", event.errorText, event.detail);
        break;

      case "finish":
        this.#applyUsage(event.usage);
        this.#paint();
        break;
    }
  }

  #setStreamStatus(status: string): void {
    const next = this.#connectionAuthPendingCount > 0 ? STATUS.connectionAuth : status;
    if (this.#status === next) return;
    this.#status = next;
    this.#paint();
  }

  #showAnswerContent(text: string): void {
    if (text.trim().length > 0) this.#turnIndicator = { kind: "answering" };
  }

  #upsertAssistantBlock(id: string, text: string, live: boolean): void {
    const content = stripTerminalControls(text).trim();
    if (content.length === 0) return;
    this.#upsertBlock({ id, kind: "assistant", body: content, live });
    this.#paint();
  }

  #upsertReasoningBlock(id: string, text: string, live: boolean, displayModes: DisplayModes): void {
    const content = stripTerminalControls(text).trim();
    if (content.length === 0) return;
    this.#upsertBlock({
      id,
      kind: "reasoning",
      body: content,
      collapsed: collapseReasoning(displayModes.reasoning, live),
      live,
    });
    this.#paint();
  }

  #upsertNativeTool(
    tool: NativeToolState,
    displayModes: DisplayModes,
    turnState: RenderTurnState,
  ): void {
    turnState.tools.set(tool.toolCallId, tool);
    if (this.#childToolCallIds.has(tool.toolCallId)) return;

    const id = toolSectionId(tool.toolCallId);
    this.#parentToolBlockIds.set(tool.toolCallId, id);
    this.#upsertBlock(renderNativeToolBlock(tool, id, displayModes.tools === "full"));
    this.#paint();
  }

  #resolveNativeToolState(
    toolCallId: string,
    turnState: RenderTurnState,
  ): NativeToolState | undefined {
    const active = turnState.tools.get(toolCallId);
    if (active !== undefined) {
      return active;
    }

    const id = this.#parentToolBlockIds.get(toolCallId) ?? toolSectionId(toolCallId);
    const block = this.#blockById.get(id);
    if (block === undefined || block.kind !== "tool") {
      return undefined;
    }

    return {
      errorText:
        block.status === "error" && typeof block.result === "string" ? block.result : undefined,
      input: block.toolInput,
      output: block.toolOutput,
      status: block.status ?? "running",
      toolCallId,
      toolName: block.title ?? "tool",
    };
  }

  #applyUsage(usage: AgentTUIStreamUsage | undefined): void {
    if (usage === undefined) return;
    const { inputTokens, outputTokens } = usage;
    if (inputTokens != null || outputTokens != null) {
      this.#totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    }
    this.#promptTokens = inputTokens ?? this.#promptTokens;
    this.#assistantOutputTokens = outputTokens ?? this.#assistantOutputTokens;

    if (this.#assistantOutputTokens != null && this.#streamStartedAt !== undefined) {
      const elapsedSeconds = (Date.now() - this.#streamStartedAt) / 1000;
      if (elapsedSeconds > 0) {
        this.#assistantTokensPerSecond = this.#assistantOutputTokens / elapsedSeconds;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------

  #paint() {
    if (!this.#isInteractive) return;

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

    const width = this.#width();
    const footer = this.#footerRows(width);
    const maxBlockRows = Math.max(1, this.#height() - footer.length);
    const committed: string[] = [];
    let previous = this.#lastCommitted;

    // Commit the leading run of finalized blocks to scrollback. Filtered log
    // blocks still enter the block history (so a later `/loglevel` can render
    // them) but contribute no rows and leave `previous` untouched — gap and
    // log-run decisions must behave as if the hidden block were not there.
    while (this.#blocks.length > 0 && this.#blocks[0]!.live === false) {
      const block = this.#blocks.shift()!;
      this.#transcriptBlocks.push(block);
      if (block.id) {
        this.#committedIds.add(block.id);
        this.#blockById.delete(block.id);
      }
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      this.#lastCommitted = previous;
      committed.push(...rows);
      this.#committedTranscriptRows.push(...rows);
    }

    // Flatten remaining live blocks. These rows are never partially committed:
    // a live block may rewrap or receive new deltas on the next paint, and
    // terminal scrollback cannot be corrected once written.
    const flat: Array<{ block: Block; row: string }> = [];
    for (const block of this.#blocks) {
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      for (let i = 0; i < rows.length; i += 1) {
        flat.push({ block, row: rows[i]! });
      }
    }

    const liveRows = [
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
    const maxBlockRows = Math.max(1, this.#height() - footer.length);
    let previous = this.#lastCommitted;
    const flat: string[] = [];

    for (const block of this.#blocks) {
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

  /** The log sources the transcript currently renders. */
  logDisplayMode(): LogDisplayMode {
    return this.#logs;
  }

  /**
   * Switches which captured log sources the transcript shows. Captured
   * output is buffered in the block history regardless of mode, so the
   * committed transcript is re-rendered under the new filter and replayed:
   * hiding removes past log lines, showing restores them at their original
   * positions.
   */
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
    this.#pushBlock({ kind: "log", title: "stderr", body, live: false });
    this.#paint();
  }

  /**
   * Advances the log filter one step (Ctrl+L) and surfaces the new mode as a
   * transient `logs: <mode>` status-line hint that clears itself after
   * {@link logLevelHintMs} of no further cycling.
   */
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

  /**
   * Re-renders {@link #committedTranscriptRows} from the committed block
   * history under the current log filter, rebuilding the `previous` chain so
   * inter-block gaps and log-run labels match what a straight-through paint
   * would have produced.
   */
  #rebuildCommittedTranscript(): void {
    const width = this.#width();
    this.#committedTranscriptRows.length = 0;
    let previous: PreviousBlock | undefined;
    for (const block of this.#transcriptBlocks) {
      if (this.#isHiddenLog(block)) continue;
      const rows = this.#renderBlock(block, width, previous);
      previous = previousBlockOf(block);
      this.#committedTranscriptRows.push(...rows);
    }
    this.#lastCommitted = previous;
  }

  #renderAgentHeaderRows(): string[] {
    const header = this.#agentHeader;
    if (header === undefined) return [];
    const input: Parameters<typeof buildAgentHeader>[0] = {
      name: header.name,
      theme: this.#theme,
      width: this.#width(),
    };
    if (header.info !== undefined) input.info = header.info;
    if (header.tip !== undefined) input.tip = header.tip;
    return buildAgentHeader(input);
  }

  #renderBlock(block: Block, width: number, previous: PreviousBlock | undefined): string[] {
    const context: Parameters<typeof renderBlockLines>[3] = { spinner: this.#spinnerFrame() };
    if (previous !== undefined) context.previous = previous;
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
    if (flow.indicator.kind === "spinner") {
      return { glyph: this.#spinnerFrame(), color: "yellow" };
    }
    return {
      glyph: this.#progressPulseGlyph(
        flow.indicator.startedAtMs,
        this.#theme.unicode ? PROGRESS_PULSE_GLYPH : PROGRESS_PULSE_ASCII_GLYPH,
      ),
      color: "green",
    };
  }

  #footerRows(width: number): string[] {
    const c = this.#theme.colors;
    const rows: string[] = [""];

    const flow = this.#setupFlow;
    if (flow !== undefined) {
      // No status line under an open flow panel: the flow is mutating the
      // very state the line shows (link, pending deploy, model), so mid-flow
      // values are guaranteed stale; it reappears, refreshed, when the
      // panel closes.
      const indicator = this.#setupFlowIndicator(flow);
      let content: FlowPanelContent;
      // A live status indicator rides alongside an open question only when one is
      // explicitly set (the install wait); ordinary questions leave it cleared,
      // so their panels stay status-free as before.
      if (flow.question !== undefined) {
        const rows = flow.question(width);
        content = { kind: "question", rows };
        if (flow.status !== undefined) {
          content = { kind: "question", rows, status: { text: flow.status, indicator } };
        }
      } else if (flow.status !== undefined) {
        content = { kind: "status", status: { text: flow.status, indicator } };
        if (flow.preview !== undefined) {
          content = {
            kind: "status",
            status: { text: flow.status, indicator },
            preview: flow.preview,
          };
        }
      } else if (flow.preview !== undefined) {
        content = { kind: "preview", text: flow.preview, indicator };
      } else {
        content = { kind: "idle", indicator };
      }
      const state: Parameters<typeof renderFlowPanel>[0] = {
        title: flow.title,
        lines: flow.hideLinesWhileQuestion === true ? [] : flow.lines,
        content,
      };
      rows.push(...renderFlowPanel(state, this.#theme, width));
      this.#pushRemoteStatusLine(rows, width);
      return rows;
    }

    // The setup attention line rides just above the prompt as a live element,
    // so resolving its issue clears it instead of leaving it stale in scrollback.
    if (this.#setupAttention !== undefined) {
      rows.push(...renderAttentionRows(this.#setupAttention, width, this.#theme), "");
    }

    if (this.#inputActive) {
      // A complete command name with a single match collapses the dropdown into
      // a dim argument hint trailing the prompt; partial or ambiguous drafts
      // still open the list above the input.
      const inlineHint =
        this.#typeahead !== undefined ? inlineCommandHint(this.#typeahead) : undefined;
      if (
        inlineHint === undefined &&
        this.#typeahead !== undefined &&
        isTypeaheadOpen(this.#typeahead)
      ) {
        rows.push(...renderCommandSuggestions(this.#typeahead, this.#theme, width));
      }
      // A fully typed known command paints blue, confirming it will dispatch
      // as a command instead of being sent to the agent as a message.
      const isCommand = isPromptControlCommand(this.#inputText);
      const ghost = inlineHint ? c.dim(` ${inlineHint}`) : "";
      const statusRows: string[] = [];
      this.#pushStatusLine(statusRows, width);
      // Keep one transcript row above the footer and one separator below the
      // prompt. Everything already in `rows` has higher-level footer ownership
      // (attention or typeahead), so the prompt receives only what remains.
      const maxPromptRows = Math.max(1, this.#height() - 1 - rows.length - 1 - statusRows.length);
      rows.push(
        ...promptInputRows({
          text: this.#inputText,
          cursor: this.#inputCursor,
          width,
          theme: this.#theme,
          caretVisible: this.#caretVisible,
          isCommand,
          ghost,
          maxRows: maxPromptRows,
        }),
      );
      rows.push(...statusRows);
      return rows;
    }

    const turnIndicator = this.#turnIndicator;
    if (turnIndicator.kind === "answering") {
      this.#pushStatusLine(rows, width);
      return rows;
    }
    const working = turnIndicator.kind === "waiting";
    const icon = working
      ? c.green(
          this.#progressPulseGlyph(
            turnIndicator.startedAtMs,
            this.#theme.unicode ? TURN_PULSE_GLYPH : TURN_PULSE_ASCII_GLYPH,
          ),
        )
      : c.dim(this.#theme.glyph.dot);
    const statusText = this.#status.length > 0 ? this.#status : "Ready";
    // Dim the live streaming status (the pulse carries the eye); keep
    // interactive prompts (approvals, questions) at full intensity.
    const status = working ? c.dim(statusText) : statusText;
    const meta = this.#statusMeta();
    const indent = working ? "  " : "";
    const line = meta
      ? `${indent}${icon} ${status}  ${c.dim(this.#theme.glyph.dot)}  ${meta}`
      : `${indent}${icon} ${status}`;
    rows.push(clip(line, width));
    const statusRows: string[] = [];
    this.#pushStatusLine(statusRows, width);
    if (working && statusRows.length > 0) rows.push("");
    rows.push(...statusRows);
    return rows;
  }

  /** Appends the persistent bottom status line below the prompt when it has content. */
  #pushStatusLine(rows: string[], width: number): void {
    const padding = this.#remoteConnection === undefined ? "" : STATUS_LINE_LEFT_PADDING;
    const contentWidth = Math.max(1, width - padding.length);
    const input: Parameters<typeof buildStatusLine>[0] = {
      theme: this.#theme,
      width: contentWidth,
    };
    if (this.#logLevelHintActive) input.logLevel = this.#logs;
    const serverUrl = this.#agentHeader?.serverUrl;
    if (serverUrl !== undefined && this.#remoteConnection === undefined) {
      const serverPort = new URL(serverUrl).port;
      if (serverPort.length > 0) input.serverPort = serverPort;
    }
    const model = this.#agentHeader?.info?.agent.model.id;
    if (model !== undefined) input.model = model;
    // The runner resolves model-provider state with `/info` before caching this
    // header, so the status bar consumes that shared snapshot.
    const endpoint = this.#agentHeader?.info?.agent.model.endpoint;
    if (endpoint !== undefined) input.endpoint = endpoint;
    // Skip the token segment entirely until a turn moves a token — a `↑ 0 ↓ 0`
    // row is noise before the first prompt.
    const inputTokens = this.#promptTokens ?? 0;
    const outputTokens = this.#assistantOutputTokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const flow: Parameters<typeof formatTokenFlow>[0] = { inputTokens, outputTokens };
      if (this.#contextSize !== undefined) flow.contextSize = this.#contextSize;
      input.tokens = formatTokenFlow(flow, this.#theme.glyph);
    }
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
    // The running token total lives on the persistent status line below;
    // this row keeps only the turn-scoped stats.
    const stats = formatAssistantResponseStats(
      {
        totalTokens: this.#totalTokens,
        outputTokens: this.#assistantOutputTokens,
        tokensPerSecond: this.#assistantTokensPerSecond,
      },
      this.#assistantResponseStats,
    );
    if (stats) parts.push(stats);
    return parts.length > 0 ? c.dim(parts.join(`  ${this.#theme.glyph.dot}  `)) : "";
  }

  #width(): number {
    // `|| 80` (not `?? 80`) so a 0-column report (e.g. a sizeless PTY) falls
    // back to a sane default instead of collapsing the layout.
    return Math.max(20, this.#output.columns || 80);
  }

  #height(): number {
    return Math.max(8, this.#output.rows || 24);
  }

  // ---------------------------------------------------------------------------
  // Foreign output capture
  // ---------------------------------------------------------------------------

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

    const restoreStdout = capture(process.stdout, "stdout");
    const restoreStderr = capture(process.stderr, "stderr");
    this.#restoreLogCapture = () => {
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
      if (this.#shouldRenderLog("stdout")) process.stdout.write(`${this.#stdoutLogBuffer}\n`);
      this.#stdoutLogBuffer = "";
    }
    if (this.#stderrLogBuffer.length > 0) {
      if (this.#shouldRenderLog("stderr")) process.stderr.write(`${this.#stderrLogBuffer}\n`);
      this.#stderrLogBuffer = "";
    }
  }

  #handleForeignOutput(source: "stdout" | "stderr", text: string): void {
    const combined = (source === "stdout" ? this.#stdoutLogBuffer : this.#stderrLogBuffer) + text;
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

    // Each write commits immediately as its own finalized block — O(1) work
    // per line and nothing held back in the live region while the TUI idles
    // at the prompt under a chatty server. The run *visuals* (label once,
    // hanging indent) come from render context: a log block painted directly
    // after a same-source log block suppresses its label and gap. Blocks are
    // created even for sources the current mode hides: the display filter is
    // applied at render time, so `/loglevel` can reveal them later. The dev
    // server's rebuild lifecycle lines are the one exception — they cycle
    // through a single in-place status block instead of stacking.
    if (source === "stdout") this.#handleCapturedStdout(content);
    else this.#handleCapturedStderr(content);
    this.#paint();
  }

  /**
   * Routes captured stdout lines: rebuild lifecycle lines update the in-place
   * status block, every other line lands as an ordinary committed log block.
   * Contiguous ordinary lines within one write stay one block, preserving the
   * single-block-per-write shape for plain output.
   */
  #handleCapturedStdout(content: string): void {
    let pending: string[] = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      const body = pending.join("\n");
      pending = [];
      if (body.trim().length === 0) return;
      this.#pushBlock({ kind: "log", title: "stdout", body, live: false });
    };

    for (const line of content.split("\n")) {
      const sandboxMessage = parseSandboxLogLine(line.trimEnd());
      if (sandboxMessage !== undefined) {
        flushPending();
        this.#pushBlock({ kind: "sandbox", body: sandboxMessage, live: false });
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

  #handleCapturedStderr(content: string): void {
    const lines = content.split("\n");
    const failedIndex = lines.findIndex((line) => {
      return parseDevRebuildLogLine(line.trimEnd())?.kind === "failed";
    });
    if (failedIndex === -1) {
      this.#pushBlock({ kind: "log", title: "stderr", body: content, live: false });
      return;
    }

    const previous = lines.slice(0, failedIndex).join("\n");
    if (previous.trim().length > 0) {
      this.#pushBlock({ kind: "log", title: "stderr", body: previous, live: false });
    }
    const failedBody = lines.slice(failedIndex).join("\n");
    this.#handleDevRebuildFailure(failedBody);
  }

  #handleDevRebuildFailure(body: string): void {
    if (this.#logs === "all") {
      if (body.trim().length === 0) return;
      this.#pushBlock({ kind: "log", title: "stderr", body, live: false });
      return;
    }
    this.#delayedDevBuildError = body;
  }

  /**
   * Applies one parsed rebuild lifecycle line to the in-place status block:
   * a "change detected" line opens (or rewrites) the cycle as
   * `<files> changed · rebuilding…`, and an outcome line flips the same block
   * to `· rebuilt` / `· reloading server…`. Only the latest state is ever
   * visible. When no cycle is live — interleaved output settled it — an
   * outcome line falls back to an ordinary log block so it isn't lost.
   */
  #applyDevRebuildUpdate(update: DevRebuildLogUpdate, line: string): void {
    const cycle = this.#activeDevRebuildCycle();

    if (update.kind === "failed") {
      this.#handleDevRebuildFailure(line);
      return;
    }

    if (update.kind === "rebuilding") {
      const summary = summarizeChangedFiles(update.events, update.more);
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

    if (cycle !== undefined) {
      cycle.block.body = formatDevRebuildStatus(cycle.state.summary, update.kind);
      if (update.kind === "rebuilt") this.#delayedDevBuildError = undefined;
      return;
    }
    if (update.kind === "rebuilt") this.#delayedDevBuildError = undefined;
    this.#pushBlock({ kind: "log", title: "stdout", body: line, live: false });
  }

  /** The rebuild status block still cycling in place, if any. */
  #activeDevRebuildCycle(): { state: { id: string; summary: string }; block: Block } | undefined {
    const state = this.#devRebuild;
    if (state === undefined) return undefined;
    const block = this.#blockById.get(state.id);
    if (block === undefined || block.live !== true) return undefined;
    return { state, block };
  }

  /**
   * Settles the in-place rebuild status: the live status block (if any)
   * finalizes so it commits to scrollback, and the next rebuild line opens a
   * fresh cycle.
   */
  #settleDevRebuildStatus(): void {
    const active = this.#devRebuild;
    if (active === undefined) return;
    this.#devRebuild = undefined;
    const block = this.#blockById.get(active.id);
    if (block !== undefined) block.live = false;
  }

  #shouldRenderLog(source: "stdout" | "stderr" | "sandbox"): boolean {
    switch (this.#logs) {
      case "none":
        return false;
      case "stderr":
        return source === "stderr";
      case "sandbox":
        return source === "sandbox";
      case "all":
        return true;
    }
  }

  /** True for a buffered log or sandbox block the current display mode filters out. */
  #isHiddenLog(block: Block): boolean {
    if (block.kind === "sandbox") return !this.#shouldRenderLog("sandbox");
    if (block.kind !== "log") return false;
    return !this.#shouldRenderLog(block.title === "stderr" ? "stderr" : "stdout");
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function chunkToString(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}

async function* iterateTUIStream(
  stream: AsyncIterable<AgentTUIStreamEvent> | ReadableStream<AgentTUIStreamEvent>,
): AsyncIterable<AgentTUIStreamEvent> {
  if (stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  yield* stream;
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
  /** A fully typed known command paints blue, confirming it will dispatch as a command. */
  readonly isCommand: boolean;
  readonly ghost: string;
  readonly maxRows: number;
}

/**
 * Renders the prompt buffer as terminal rows, followed by a blank row that keeps
 * the persistent status visually separate. The buffer can carry newlines from
 * paste or Shift+Enter, so it renders one row per logical line and windows tall
 * input to `maxRows`, marking any hidden rows with an ellipsis.
 */
function promptInputRows({
  text,
  cursor,
  width,
  theme,
  caretVisible,
  isCommand,
  ghost,
  maxRows,
}: PromptInputRowsInput): string[] {
  const c = theme.colors;
  const style = (segment: string): string => {
    const rendered = renderInputText(segment);
    return isCommand && rendered.length > 0 ? c.blue(rendered) : rendered;
  };

  const layout = layoutPromptInput({ text, cursor });
  const visibleCount = Math.min(Math.max(1, maxRows), layout.rows.length);
  const top = Math.max(
    0,
    Math.min(layout.caretRow - visibleCount + 1, layout.rows.length - visibleCount),
  );
  const promptGlyph = c.cyan(theme.glyph.prompt);
  const ellipsis = c.dim(theme.glyph.ellipsis);
  // Reserve the leading pad, gutter, and block cursor's trailing cell at end-of-line.
  const budget = Math.max(1, width - 4);
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
      // Window the active row so the caret remains visible on long lines.
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
      // The argument hint trails the caret only on a single-line command draft.
      if (ghost.length > 0 && layout.rows.length === 1) body += ghost;
    } else {
      body = style(row.text);
    }
    out.push(clip(` ${gutter} ${body}`, width));
  }
  out.push("");
  return out;
}

/** Kind + title of the previously rendered block, for gap / run decisions. */
type PreviousBlock = { kind: BlockKind; title?: string };

function previousBlockOf(block: Block): PreviousBlock {
  const previous: PreviousBlock = { kind: block.kind };
  if (block.title !== undefined) previous.title = block.title;
  return previous;
}

/**
 * Decides whether a block gets a blank line above it. Top-level "speakers"
 * (user, assistant, reasoning, …) always breathe; tool rows stay tight under
 * the message they belong to. Log runs breathe on both sides — the run leads
 * with a gap and whatever follows it gets one too — except between
 * consecutive same-source log blocks, which read as one continuous run
 * (their labels are suppressed by the renderer for the same reason).
 */
function leadsWithGap(block: Block, previous: PreviousBlock | undefined): boolean {
  if (block.kind === "sandbox" && previous?.kind === "sandbox") {
    return false;
  }
  if (previous?.kind === "sandbox" && block.kind !== "sandbox") return true;
  if (block.kind === "log" && previous?.kind === "log") {
    // stdout → stderr (or vice versa) gets air; a same-source continuation
    // stays tight beneath the run it extends.
    return previous.title !== block.title;
  }
  if (previous?.kind === "log" && block.kind !== "log") return true;
  switch (block.kind) {
    case "user":
    case "assistant":
    case "reasoning":
    case "subagent":
    case "error":
    case "notice":
    case "question":
    case "connection-auth":
    case "sandbox":
    case "log":
    // The echoed command is typed input — it gets the same air a user
    // message does; flow warnings, the boot attention line, and a refreshed
    // agent header breathe too.
    case "command":
    case "warning":
    case "flow":
    case "agent-header":
      return true;
    // The elbow result hangs tight under its invocation — never a gap.
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
    /^sandbox template "[^"]+" \([^)]+\): (checking|reusing|loading microsandbox runtime|microsandbox runtime ready)\b/i.test(
      message,
    )
  );
}

function clipLiveRows(
  rows: readonly string[],
  maxRows: number,
  width: number,
  theme: Theme,
): string[] {
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

function collapseReasoning(mode: TerminalPartDisplayMode, isLastPart: boolean): boolean {
  switch (mode) {
    case "collapsed":
      return true;
    case "auto-collapsed":
      return !isLastPart;
    default:
      return false;
  }
}

function renderNativeToolBlock(tool: NativeToolState, id: string, expanded: boolean): Block {
  const block: Block = {
    id,
    kind: "tool",
    title: stripTerminalControls(tool.toolName),
    subtitle: summarizeToolArgs(tool.input),
    status: tool.status,
    live: tool.status === "running" || tool.status === "approval",
    expanded,
    toolInput: tool.input,
  };

  if (tool.output !== undefined) {
    block.result = summarizeToolResult(tool.output);
    block.toolOutput = tool.output;
  } else if (tool.errorText !== undefined) {
    block.result = stripTerminalControls(tool.errorText);
  }

  return block;
}

function subagentToolStatus(status: SubagentToolUpdate["status"]): ToolStatus {
  switch (status) {
    case "approval-requested":
      return "approval";
    case "executing":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "error";
  }
}

function formatToolApprovalTitle(request: AgentTUIToolApprovalRequest): string {
  return stripTerminalControls(request.title ?? request.toolName);
}

function toolSectionId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function questionSectionId(requestId: string): string {
  return `question:${requestId}`;
}

function subagentHeaderId(callId: string): string {
  return `subagent:${callId}:header`;
}

function subagentStepSectionId(callId: string, sectionKey: number): string {
  return `subagent:${callId}:step:${sectionKey}`;
}

function subagentToolSectionId(callId: string, childCallId: string): string {
  return `subagent:${callId}:tool:${childCallId}`;
}

function connectionAuthSectionId(connectionName: string): string {
  return `connection-auth:${connectionName}`;
}

function formatConnectionAuthContent(update: ConnectionAuthUpdate): string {
  const lines: string[] = [];
  const description = stripTerminalControls(update.description);
  if (description.length > 0) lines.push(description);
  const challenge = update.challenge;
  if (challenge?.url) lines.push(`URL: ${stripTerminalControls(challenge.url)}`);
  if (challenge?.userCode) lines.push(`Code: ${stripTerminalControls(challenge.userCode)}`);
  if (challenge?.expiresAt) lines.push(`Expires: ${stripTerminalControls(challenge.expiresAt)}`);
  if (challenge?.instructions) lines.push(stripTerminalControls(challenge.instructions));
  if (update.reason !== undefined) {
    const reason = stripTerminalControls(update.reason);
    if (reason.length > 0) lines.push(`Reason: ${reason}`);
  }
  return lines.join("\n");
}

function formatQuestionContent(
  question: AgentTUIInputQuestion,
  highlight: number | undefined,
  theme: Theme,
): string {
  const c = theme.colors;
  const lines: string[] = [];
  const options = question.options ?? [];

  if (options.length > 0) {
    for (const [index, option] of options.entries()) {
      const labelText = stripTerminalControls(option.label);
      const descriptionText =
        option.description === undefined ? "" : stripTerminalControls(option.description);
      const selected = highlight === index;
      const description =
        descriptionText.length > 0
          ? `${selected ? " " : "  "}${c.dim(`— ${descriptionText}`)}`
          : "";
      const content = selected ? `${theme.glyph.selectedPointer} ${labelText}` : `  ${labelText}`;
      const selection = renderCursorRow(content, selected, c);
      lines.push(`${selection}${description}`);
    }
    if (question.allowFreeform === true) {
      const selected = highlight === options.length;
      const label = "Type your own answer";
      const content = selected ? `${theme.glyph.selectedPointer} ${label}` : `  ${c.dim(label)}`;
      lines.push(renderCursorRow(content, selected, c));
    }
  } else {
    lines.push(c.dim("  (type your answer)"));
  }

  return lines.join("\n");
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
