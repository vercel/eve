import { eveVersionTag } from "#cli/banner.js";
import {
  isProgressPulseVisible,
  PROGRESS_PULSE_ASCII_GLYPH,
  PROGRESS_PULSE_GLYPH,
} from "#cli/ui/progress-pulse.js";
import {
  clipVisible,
  stripAnsi,
  stripTerminalControls,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";
import type { ProviderPickerChoice, ProviderPickerRequest } from "#setup/flows/provider.js";
import type { PlannerNavigation } from "#setup/prompter.js";
import {
  initialSelectState,
  orderedSelection,
  reduceSelect,
  searchActionQuery,
  selectValueAtCursor,
  type SelectState,
} from "#setup/cli/select-state.js";
import { readGatewayServiceTier } from "#shared/gateway-service-tier.js";
import { toErrorMessage } from "#shared/errors.js";

import type { DevDiagnostics } from "../diagnostics.js";
import { buildAgentHeader } from "./agent-header.js";
import type { PromptArgumentSuggestion } from "./argument-typeahead.js";
import {
  renderAttentionRows,
  renderBlockLines,
  type Block,
  type BlockKind,
  type DisplayBlock,
} from "./blocks.js";
import { copyTextToClipboard } from "./clipboard.js";
import {
  moveTypeaheadSelection,
  renderCommandSuggestions,
  selectedTypeaheadCommand,
  typeaheadCompletion,
  typeaheadFor,
} from "./command-typeahead.js";
import { Composer, promptInputRows } from "./composer.js";
import type { AgentTUIConversationView, TokenUsage } from "./conversation-view.js";
import { interruptedError } from "./errors.js";
import { renderFlowDrawer, renderTransientDrawer } from "./flow-drawer.js";
import {
  applyLineEditorKey,
  EMPTY_LINE,
  KillRing,
  lineOf,
  movePromptLine,
  type LineState,
} from "./line-editor.js";
import { nextLogDisplayMode, type LogDisplayMode } from "./log-display-mode.js";
import { ingestLog, type BuildPhase } from "./logs.js";
import { detectMarkdownRendering } from "./markdown.js";
import { initialPromptPlaceholder } from "./prompt-placeholder.js";
import {
  PROMPT_COMMANDS,
  type ArgumentTypeaheadCommand,
  type PromptCommandSpec,
} from "./prompt-commands.js";
import {
  initialProviderPickerState,
  transitionProviderPicker,
  type ProviderPickerEvent,
} from "./provider-picker.js";
import {
  fitQuestionPanel,
  inputContextLabel,
  renderQuestionPanel,
  renderQuestionPrompt,
} from "./question-panel.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";
import type {
  AgentTUIAgentHeader,
  AgentTUIInput,
  AgentTUIInputContext,
  AgentTUIInputOption,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
  CommandPresentation,
} from "./runner.js";
import {
  enterBadge,
  renderAcknowledgeQuestion,
  renderSelectQuestion,
  renderTextQuestion,
  type FlowPanelContent,
  type FlowPanelLine,
  type FlowPanelStatus,
  type SetupPanelOption,
  type SetupSelectPanelState,
} from "./setup-panel.js";
import type {
  SetupEditableSelectResult,
  SetupFlowInterrupt,
  SetupFlowRenderer,
  SetupSelectRequest,
  SetupSelectResult,
} from "./setup-flow.js";
import { reduceSetupSelectInput, setupSelectionIntent } from "./setup-selection-input.js";
import { buildStatusLine, type DevBuildStatus } from "./status-line.js";
import { formatTokenFlow, formatTurnDuration, type TerminalKey } from "./stream-format.js";
import { renderTaskPanelRows } from "./task-activity.js";
import {
  BACKGROUND_COLOR_QUERY,
  parseBackgroundColorReply,
  type RgbColor,
} from "./terminal-background.js";
import { Terminal, type CapturedLog, type TerminalInput, type TerminalOutput } from "./terminal.js";
import { createTheme, detectUnicode, type Theme } from "./theme.js";
import { groupToolBlocksForDisplay } from "./tool-block-groups.js";
import { ConversationTranscript, turnActivity, type TranscriptOptions } from "./transcript.js";
import { TurnClock } from "./turn-clock.js";
import type { TraceViewerOpenOptions, TraceViewerRenderer } from "./traces/trace-viewer-session.js";
import { TraceViewerSession } from "./traces/trace-viewer-session.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";

export type { TerminalInput, TerminalOutput };

type TerminalRendererOptions = {
  input?: TerminalInput;
  output?: TerminalOutput;
  /** Shows tool input/output, reasoning, and each subagent message and tool call in full. */
  verbose?: boolean;
  captureForeignOutput?: boolean;
  logs?: LogDisplayMode;
  color?: boolean;
  unicode?: boolean;
  renderMarkdown?: boolean;
  /** The process's diagnostics recorder (log, dump, stats); local sessions only. */
  diagnostics?: DevDiagnostics;
  /** Slash commands available in this local or remote session. */
  availablePromptCommands?: readonly PromptCommandSpec[];
  /** Catalog entries available to inline `/model`, `/add`, and `/login` completion. */
  argumentSuggestions?: (
    command: ArgumentTypeaheadCommand,
  ) => Promise<readonly PromptArgumentSuggestion[]>;
  onExitRequest?: () => void;
};

/** Settles one surface's question; either call pops the surface off the stack. */
interface Settle<T> {
  done(value: T): void;
  fail(error: unknown): void;
}

/**
 * Something that takes the keyboard on top of the composer: an approval, a
 * question, a setup prompt, a panel, or a key trap. The top surface gets
 * every key; rows say what it paints.
 */
interface Surface {
  key(key: TerminalKey): void;
  /**
   * The surface's painted rows. `drawer` rows replace the composer and keep the
   * task panel above them; `panel` rows replace the whole footer; `flow` rows
   * paint inside the open setup flow. Key traps paint nothing.
   */
  readonly placement?: "drawer" | "panel" | "flow";
  rows?(width: number): string[];
  /** Whether a text caret blinks while this surface is on top. */
  caret?(): boolean;
  dispose?(): void;
}

interface StackEntry {
  readonly surface: Surface;
  /** Settles the surface when the TUI closes. */
  stop(): void;
}

type SetupFlowState = {
  title: string;
  navigation?: PlannerNavigation;
  /** When the flow's pulse started, so its blink stays on a steady beat. */
  startedAtMs: number;
  lines: FlowPanelLine[];
  summary?: { headline: string; facts: readonly { label: string; value: string }[] };
  status?: { text: string; startedAtMs: number };
  /** Latest subprocess output line; replaced per write, never persisted. */
  preview?: string;
  /** Recent subprocess output, pulled in as evidence when a warning settles it. */
  outputBuffer: string[];
  questionTitle?: string;
  /** First line produced after the previous task-list question settled. */
  taskListLineStart?: number;
  /** Task-list questions render their latest outcomes inside the question. */
  hideLinesWhileQuestion?: boolean;
};

/** Kind + title of the previously rendered block, for gap and run decisions. */
type PreviousBlock = { kind: BlockKind; title?: string; subagentCallId?: string };

/** How much subprocess output a warning or error can pull in as its evidence. */
const FLOW_OUTPUT_BUFFER_CAP = 40;
const STATUS_LINE_LEFT_PADDING = "  ";
const tickMs = 90;
const caretBlinkMs = 500;
// Two rules, two padding rows, and one navigation row stay outside the body viewport.
const drawerChromeRows = 5;
const logLevelHintMs = 5_000;
// Fast rebuilds skip their in-progress state; slow builds still show progress.
const devBuildProgressDelayMs = 250;
const devBuildLoadedStatusMs = 4_000;
/** The end-of-turn coda renders only for turns that were long or expensive. */
const turnStatsMinDurationMs = 10_000;
const turnStatsMinInputTokens = 20_000;

/**
 * The `eve dev` terminal UI. One state, one stack of surfaces on top of an
 * always-open composer, and one view: every change updates state and repaints
 * the live region. Finalized blocks move to native scrollback exactly once.
 */
export class TerminalRenderer {
  readonly #terminal: Terminal;
  readonly #output: TerminalOutput;
  readonly #theme: Theme;
  readonly #renderMarkdown: boolean;
  readonly #verbose: boolean;
  readonly #diagnostics?: DevDiagnostics;
  readonly #onExitRequest?: () => void;
  readonly #killRing = new KillRing();
  readonly #composer: Composer;
  readonly #stack: StackEntry[] = [];
  readonly #inputs: AgentTUIInput[] = [];
  #inputWaiter?: { resolve(input: AgentTUIInput | undefined): void; reject(error: Error): void };
  #logs: LogDisplayMode;

  /** Blocks not yet in scrollback, in transcript order. */
  #blocks: Block[] = [];
  readonly #blockById = new Map<string, Block>();
  /** Conversation block ids already in scrollback, so a later snapshot never repeats them. */
  readonly #committedIds = new Set<string>();
  /** Conversation blocks currently live, so ones the projection drops can leave. */
  #conversationBlockIds = new Set<string>();
  /** Rows to write to scrollback on the next paint, ahead of the settled blocks. */
  #pendingRows: string[] = [];
  #lastCommitted?: PreviousBlock;
  #pendingCommandEcho?: Block;

  readonly #transcript = new ConversationTranscript();
  #view?: AgentTUIConversationView;
  readonly #turnClock = new TurnClock();
  #hasUserMessage = false;
  #agentHeader?: AgentTUIAgentHeader;
  #agentHeaderBody?: string;
  #initialPromptPlaceholder = "Send a message…";
  #subagentNames?: readonly string[];
  #title = "eve";
  #startupPhase?: "starting" | "connecting" | "updating";
  #startupStartedAt = Date.now();
  #flow?: SetupFlowState;
  /** A setup status set with no flow open, such as reloading a model after `/login`. */
  #flowlessStatus?: string;
  #setupAttention?: string;
  #vercelStatus?: VercelStatusSnapshot;
  #remoteConnection?: RemoteConnectionSnapshot;
  #build?: { status: DevBuildStatus; atMs: number };
  #logHintUntil = 0;
  #sessionId?: string;
  #traceView?: TraceViewerSession;
  #terminalBackground?: RgbColor;

  #closed = false;
  #everStarted = false;
  #suspended = false;
  #exitRequested = false;
  #spinnerIndex = 0;
  #activityPulseStartedAtMs = Date.now();
  #caretEpoch = Date.now();
  #ticker?: { timer: ReturnType<typeof setInterval>; period: number };
  #painting = false;
  #paintAgain = false;
  #lastFrame?: string;

  readonly setupFlow: SetupFlowRenderer = {
    begin: (title) => this.#beginFlow(title),
    setNavigation: (navigation) => this.#updateFlow((flow) => (flow.navigation = navigation)),
    end: (options) => this.#endFlow(options?.preserveDiagnostics ?? true),
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

  /** The `/traces` full-screen viewer; resolves when the user closes it. */
  readonly traceViewer: TraceViewerRenderer = {
    open: (options) => this.#openTraceViewer(options),
  };

  constructor(options: TerminalRendererOptions = {}) {
    const output = options.output ?? process.stdout;
    this.#output = output;
    this.#theme = createTheme({
      color: options.color ?? true,
      unicode: options.unicode ?? detectUnicode(),
    });
    this.#renderMarkdown = options.renderMarkdown ?? detectMarkdownRendering();
    this.#verbose = options.verbose ?? false;
    this.#logs = options.logs ?? "error";
    this.#diagnostics = options.diagnostics;
    this.#onExitRequest = options.onExitRequest;
    this.#terminal = new Terminal(
      {
        input: options.input ?? process.stdin,
        output,
        captureForeignOutput: options.captureForeignOutput ?? output === process.stdout,
        diagnostics: options.diagnostics,
      },
      {
        key: (key) => this.#dispatchKey(key),
        osc: (value) => this.#handleOscReply(value),
        resize: () => this.#paint(),
        log: (entry) => this.#log(entry),
      },
    );
    this.#composer = new Composer({
      theme: this.#theme,
      commands: options.availablePromptCommands ?? PROMPT_COMMANDS,
      argumentSuggestions: options.argumentSuggestions,
      killRing: this.#killRing,
      working: () => this.#view?.working === true,
      emit: (input) => this.#emitInput(input),
      echoCommand: (text) => this.#pushCommandEcho(text),
      sentMessage: () => {
        this.#hasUserMessage = true;
        this.#diagnostics?.recordPrompt();
      },
      exit: () => {
        this.#requestExit();
        this.#close();
      },
      cycleLogs: () => {
        this.#logHintUntil = Date.now() + logLevelHintMs;
        this.setLogDisplayMode(nextLogDisplayMode(this.#logs));
      },
      repaint: () => this.#paint(),
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Takes the terminal and opens the composer. Idempotent; a closed renderer stays closed. */
  start(options: { readonly title?: string; readonly initialDraft?: string } = {}): void {
    if (options.title !== undefined) this.#title = options.title;
    if (options.initialDraft !== undefined && this.#composer.text.length === 0) {
      this.#composer.setText(options.initialDraft);
    }
    if (this.#closed || this.#terminal.active) return;
    this.#everStarted = true;
    this.#terminal.start();
    this.#paint();
  }

  setStartupPhase(phase: "starting" | "connecting" | "updating" | undefined): void {
    if (phase !== undefined && this.#startupPhase === undefined)
      this.#startupStartedAt = Date.now();
    this.#startupPhase = phase;
    this.#paint();
  }

  /** Last server session id the runner reported; named in the parting line. */
  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  shutdown(): void {
    this.#close();
    // The parting line: the boot banner's dim counterpart, naming the session
    // so the conversation the user just left can be found again.
    if (this.#everStarted) {
      this.#everStarted = false;
      const session =
        this.#sessionId === undefined ? "" : ` ${this.#theme.glyph.dot} session ${this.#sessionId}`;
      this.#output.write(`${this.#theme.colors.dim(`${eveVersionTag()}${session}`)}\n`);
    }
  }

  requestInterrupt(): void {
    this.#close();
  }

  exitRequested(): boolean {
    return this.#exitRequested;
  }

  #requestExit(): void {
    this.#exitRequested = true;
    this.#onExitRequest?.();
  }

  /** Settles every surface, rejects the pending input read, and restores the terminal. */
  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of [...this.#stack].reverse()) entry.stop();
    const waiter = this.#inputWaiter;
    this.#inputWaiter = undefined;
    waiter?.reject(interruptedError());
    this.#stopTicker();
    if (!this.#terminal.active) return;
    // Settled blocks land in scrollback before the live region is wiped.
    this.#settleCommandEcho();
    this.#paint();
    this.#terminal.stop();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /**
   * The next composer action. Actions taken while nothing reads queue here.
   * Resolves `undefined` when `signal` aborts, and rejects once the TUI closes.
   */
  nextInput(signal?: AbortSignal): Promise<AgentTUIInput | undefined> {
    if (this.#closed) return Promise.reject(interruptedError());
    const queued = this.#inputs.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted === true) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#inputWaiter = waiter;
      signal?.addEventListener(
        "abort",
        () => {
          if (this.#inputWaiter !== waiter) return;
          this.#inputWaiter = undefined;
          resolve(undefined);
        },
        { once: true },
      );
    });
  }

  #emitInput(input: AgentTUIInput): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = undefined;
    if (waiter === undefined) this.#inputs.push(input);
    else waiter.resolve(input);
  }

  #dispatchKey(key: TerminalKey): void {
    this.#killRing.interruptYank(key);
    this.#caretEpoch = Date.now();
    const top = this.#stack.at(-1);
    if (top !== undefined) top.surface.key(key);
    // An open setup flow covers the composer; keys it does not ask for are dropped.
    else if (this.#flow === undefined) this.#composer.key(key);
    this.#paint();
  }

  #handleOscReply(value: string): void {
    const background = parseBackgroundColorReply(value);
    if (background === undefined) return;
    this.#terminalBackground = background;
    this.#traceView?.setTerminalBackground(background);
  }

  /**
   * Pushes a surface and resolves with its answer. `onStop` is the answer when
   * the TUI closes underneath it; without one the question rejects as interrupted.
   */
  #ask<T>(make: (settle: Settle<T>) => Surface, onStop?: () => T): Promise<T> {
    if (this.#closed) {
      return onStop === undefined ? Promise.reject(interruptedError()) : Promise.resolve(onStop());
    }
    return new Promise<T>((resolve, reject) => {
      let entry: StackEntry | undefined;
      const pop = (): boolean => {
        const index = entry === undefined ? -1 : this.#stack.indexOf(entry);
        if (index === -1) return false;
        this.#stack.splice(index, 1);
        entry!.surface.dispose?.();
        this.#paint();
        return true;
      };
      const settle: Settle<T> = {
        done: (value) => {
          if (pop()) resolve(value);
        },
        fail: (error) => {
          if (pop()) reject(error);
        },
      };
      const surface = make(settle);
      entry = {
        surface,
        stop: () =>
          onStop === undefined ? settle.fail(interruptedError()) : settle.done(onStop()),
      };
      this.#stack.push(entry);
      this.#paint();
    });
  }

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  /**
   * Commits the agent header to scrollback, and again after a reload only when
   * it changed: an identical banner repeated per reload is noise.
   */
  renderAgentHeader(header: AgentTUIAgentHeader): void {
    this.#title = header.name;
    this.#agentHeader = header;
    this.#subagentNames = header.info?.subagents.local.map((subagent) => subagent.name);
    this.#initialPromptPlaceholder = initialPromptPlaceholder(
      header.info,
      header.localDevelopment === true,
    );
    const body = this.#agentHeaderRows().join("\n");
    if (body !== this.#agentHeaderBody) {
      this.#agentHeaderBody = body;
      this.#pushBlock({ kind: "agent-header", body, live: false });
    }
    this.#paint();
  }

  /**
   * Reconciles the transcript with one conversation snapshot. Blocks keep
   * their position once shown and leave the live region once final.
   */
  renderConversation(view: AgentTUIConversationView): void {
    const wasWorking = this.#view?.working === true;
    this.#view = view;
    if (view.conversation.messages.some((message) => message.role === "user")) {
      this.#hasUserMessage = true;
    }
    const projection = this.#transcript.project(view, this.#transcriptOptions());
    const ids = new Set<string>();
    for (const [index, block] of projection.blocks.entries()) {
      const id = block.id!;
      if (this.#committedIds.has(id)) continue;
      ids.add(id);
      const existing = this.#blockById.get(id);
      if (existing === block) continue;
      if (existing !== undefined) {
        this.#blocks[this.#blocks.indexOf(existing)] = block;
        this.#blockById.set(id, block);
        continue;
      }
      // A new block goes before the next projected block still on screen, or at the live edge.
      const next = projection.blocks
        .slice(index + 1)
        .find((candidate) => this.#blockById.has(candidate.id!));
      const at = next === undefined ? -1 : this.#blocks.indexOf(this.#blockById.get(next.id!)!);
      if (at === -1) this.#blocks.push(block);
      else this.#blocks.splice(at, 0, block);
      this.#blockById.set(id, block);
    }
    for (const id of this.#conversationBlockIds) {
      if (!ids.has(id)) this.#removeBlock(id);
    }
    this.#conversationBlockIds = ids;
    for (const block of projection.arrivals) this.#pushBlock(block);
    if (view.working && !wasWorking) {
      if (!this.#turnClock.armed) this.#turnClock.arm(this.#usage());
      this.#activityPulseStartedAtMs = Date.now();
    }
    if (!view.working) {
      this.#composer.cancelRequested = false;
      // Approvals answered mid-turn don't split the turn's coda.
      if (this.#stack.length === 0) this.#commitTurnStats();
    }
    this.#paint();
  }

  /**
   * Marks where a dead session was replaced mid-conversation. The old
   * conversation's blocks settle as shown; a fresh session may reuse their ids.
   */
  renderSessionBoundary(): void {
    this.#commitTurnStats();
    const stopped = this.#transcript.stopWorking(this.#transcriptOptions());
    for (const id of this.#conversationBlockIds) {
      const block = this.#blockById.get(id);
      if (block === undefined) continue;
      this.#blockById.delete(id);
      const { id: _id, ...settled } = block;
      this.#blocks[this.#blocks.indexOf(block)] = { ...settled, live: false };
    }
    for (const { id: _id, ...line } of stopped) this.#pushBlock(line);
    this.#committedIds.clear();
    this.#clearConversationState();
    const { colors: c, glyph: g } = this.#theme;
    this.#pushBlock({
      kind: "session-boundary",
      body: c.dim(`${g.cornerOpen}${g.dash.repeat(2)} Session restarted, clear context.`),
      live: false,
    });
    this.#paint();
  }

  /** `/new`: clears the screen and the conversation, keeping workspace state such as the model. */
  reset(): void {
    this.#blocks = [];
    this.#blockById.clear();
    this.#committedIds.clear();
    this.#pendingRows = [];
    this.#lastCommitted = undefined;
    this.#agentHeaderBody = undefined;
    this.#hasUserMessage = false;
    this.#clearConversationState();
    if (this.#terminal.active) this.#terminal.live.clearAll();
    this.#lastFrame = undefined;
    this.#paint();
  }

  /** The one authority for state that dies with a server-side conversation context. */
  #clearConversationState(): void {
    this.#transcript.reset();
    this.#view = undefined;
    this.#conversationBlockIds = new Set();
    this.#composer.cancelRequested = false;
    this.#turnClock.reset();
  }

  /** Commits one dim informational line. */
  renderNotice(text: string): void {
    const body = stripTerminalControls(text);
    if (body.trim().length === 0) return;
    this.#pushBlock({ kind: "notice", body, live: false });
    this.#paint();
  }

  /** Commits one error block, such as a message the session did not accept. */
  renderError(title: string, message: string): void {
    const cleanTitle = stripTerminalControls(title);
    const body = stripTerminalControls(message);
    this.#diagnostics?.append({
      source: "workflow",
      summary: `${cleanTitle}: ${body}`,
      detail: body,
    });
    this.#pushBlock({ kind: "error", title: cleanTitle, body, live: false });
    this.#paint();
  }

  /** Replaces the composer's draft, e.g. with the command picked from `/help`. */
  setDraft(text: string): void {
    this.#composer.setText(text);
    this.#paint();
  }

  /** Puts a cancelled turn's message back into an empty composer, with a notice. */
  restoreDraft(text: string): void {
    if (this.#composer.text.length > 0) return;
    this.#composer.setText(text);
    this.renderNotice(
      "The turn was cancelled from outside this prompt, so its message is back in the input.",
    );
  }

  /** Sets the clearable setup attention line above the prompt; `undefined` clears it. */
  renderSetupWarning(text: string | undefined): void {
    const content = text === undefined ? "" : stripTerminalControls(text);
    this.#setupAttention = content.trim().length === 0 ? undefined : content;
    this.#paint();
  }

  /** Echoes a slash-command invocation that was started without prompt input. */
  renderCommandInvocation(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    this.#pushCommandEcho(content);
    this.#paint();
  }

  /** Completes the active command's transcript record in one operation. */
  finishCommand(outcome: CommandPresentation): void {
    const echo = this.#pendingCommandEcho;
    if (outcome.kind === "dismiss") {
      if (echo !== undefined) {
        this.#pendingCommandEcho = undefined;
        this.#blocks = this.#blocks.filter((block) => block !== echo);
      }
      this.#paint();
      return;
    }
    this.#settleCommandEcho(outcome.summary);
    if (echo !== undefined) echo.status = "done";
    const body = outcome.message === undefined ? "" : stripAnsi(outcome.message);
    if (body.trim().length > 0) {
      // Work that streamed in while the command ran must not come between it and its result.
      const at = echo === undefined ? -1 : this.#blocks.indexOf(echo);
      const result: Block = { kind: "result", body, live: false };
      if (at === -1) this.#pushBlock(result);
      else this.#blocks.splice(at + 1, 0, result);
    }
    this.#paint();
  }

  /** The echo stays live until its command settles: its gutter pulses, then carries the outcome. */
  #pushCommandEcho(body: string): void {
    this.#settleCommandEcho();
    const block: Block = { kind: "command", body, live: true };
    this.#pendingCommandEcho = block;
    this.#pushBlock(block);
  }

  #settleCommandEcho(summary?: string): void {
    const block = this.#pendingCommandEcho;
    if (block === undefined) return;
    this.#pendingCommandEcho = undefined;
    block.live = false;
    if (summary !== undefined) block.result = stripTerminalControls(summary);
  }

  #pushBlock(block: Block): void {
    this.#blocks.push(block);
    if (block.id !== undefined) this.#blockById.set(block.id, block);
  }

  #removeBlock(id: string): void {
    this.#blocks = this.#blocks.filter((block) => block.id !== id);
    this.#blockById.delete(id);
  }

  /** Writes a block to scrollback now, ahead of anything still live. */
  #commitNow(block: Block): void {
    this.#pendingRows.push(
      ...this.#renderBlock(block, this.#terminal.width(), this.#lastCommitted),
    );
    this.#lastCommitted = previousBlockOf(block);
  }

  /** The end-of-turn coda, for turns long or expensive enough to earn a row. */
  #commitTurnStats(): void {
    const settled = this.#turnClock.settle(this.#usage());
    if (settled === undefined) return;
    this.#diagnostics?.reportStats();
    if (
      settled.elapsedMs <= turnStatsMinDurationMs &&
      settled.inputTokens <= turnStatsMinInputTokens
    ) {
      return;
    }
    const flow =
      settled.inputTokens === 0 && settled.outputTokens === 0
        ? ""
        : ` (${formatTokenFlow(settled, this.#theme.glyph)})`;
    this.#pushBlock({
      kind: "turn-stats",
      body: `Done in ${formatTurnDuration(settled.elapsedMs)}${flow}`,
      live: false,
    });
  }

  #usage(): TokenUsage {
    return this.#view?.data.usage ?? { inputTokens: 0, outputTokens: 0 };
  }

  #transcriptOptions(): TranscriptOptions {
    return {
      verbose: this.#verbose,
      subagentNames: this.#subagentNames,
      diagnosticsPath: this.#diagnostics?.displayPath,
      dot: this.#theme.glyph.dot,
    };
  }

  // ---------------------------------------------------------------------------
  // Logs
  // ---------------------------------------------------------------------------

  /** The log severity the transcript shows. */
  logDisplayMode(): LogDisplayMode {
    return this.#logs;
  }

  /** Switches which log lines show from now on; lines already hidden stay in the diagnostics log. */
  setLogDisplayMode(mode: LogDisplayMode): void {
    this.#logs = mode;
    this.#paint();
  }

  /** Captured output lands in scrollback at once; it never waits behind live blocks. */
  #log(entry: CapturedLog): void {
    if (entry.source !== "eve") {
      const detail = stripAnsi(entry.text);
      this.#diagnostics?.append(
        entry.level === undefined
          ? { source: entry.source, detail }
          : { source: entry.source, level: entry.level, detail },
      );
    }
    const ingest = ingestLog(entry, {
      mode: this.#logs,
      diagnosticsPath: this.#diagnostics?.displayPath,
    });
    if (ingest.build !== undefined) this.#applyBuild(ingest.build);
    for (const block of ingest.blocks) this.#commitNow(block);
    this.#paint();
  }

  #applyBuild(build: BuildPhase): void {
    const now = Date.now();
    if (build.phase === "building") {
      this.#build = { status: { phase: "building", summary: build.summary }, atMs: now };
    } else if (build.phase === "failed") {
      this.#build = undefined;
    } else if (this.#build !== undefined) {
      this.#build = { status: { ...this.#build.status, phase: "complete" }, atMs: now };
    }
  }

  /** The build status while it should show: a slow rebuild in progress, or one that just finished. */
  #visibleBuild(now = Date.now()): DevBuildStatus | undefined {
    const build = this.#build;
    if (build === undefined) return undefined;
    const age = now - build.atMs;
    if (build.status.phase === "building") {
      return age >= devBuildProgressDelayMs ? build.status : undefined;
    }
    return age < devBuildLoadedStatusMs ? build.status : undefined;
  }

  // ---------------------------------------------------------------------------
  // Status pushed by the runner
  // ---------------------------------------------------------------------------

  setVercelStatus(status: VercelStatusSnapshot): void {
    this.#vercelStatus = status;
    this.#paint();
  }

  setRemoteConnectionStatus(status: RemoteConnectionSnapshot): void {
    this.#remoteConnection = status;
    this.#paint();
  }

  // ---------------------------------------------------------------------------
  // Drawers: approvals, questions, help, info
  // ---------------------------------------------------------------------------

  async readToolApproval(
    request: AgentTUIToolApprovalRequest,
  ): Promise<AgentTUIToolApprovalResponse> {
    let cursor = 0;
    return await this.#ask<AgentTUIToolApprovalResponse>((settle) => {
      const approve = () => settle.done({ approved: true });
      const deny = () => settle.done({ approved: false, reason: "Denied by user." });
      return {
        placement: "drawer",
        rows: (width) =>
          this.#drawer(
            renderQuestionPanel(
              {
                prompt: request.prompt,
                options: [
                  { id: "yes", label: "Yes" },
                  { id: "no", label: "No" },
                ],
                cursor,
                allowFreeform: false,
                editor: EMPTY_LINE,
                caretVisible: false,
                maxRows: this.#terminal.height() - drawerChromeRows,
              },
              this.#theme,
              width,
            ),
            "y yes · n no · Ctrl-C cancel",
            width,
            request.context,
          ),
        key: (key) => {
          switch (key.type) {
            case "text": {
              // An ordinary bracketed paste must not confirm by accident.
              if (key.framing !== "unframed") return;
              const value = key.value.toLowerCase();
              if (value === "y") approve();
              else if (value === "n") deny();
              return;
            }
            case "up":
            case "ctrl-p":
              cursor = 0;
              return;
            case "down":
            case "ctrl-n":
              cursor = 1;
              return;
            case "enter":
              if (cursor === 0) approve();
              else deny();
              return;
            case "ctrl-c":
              this.#close();
              return;
            default:
              return;
          }
        },
      };
    });
  }

  /**
   * Asks an agent's question in a drawer. Esc with nothing to clear dismisses
   * it: it resolves `undefined` and the question stays open on the server.
   */
  async readInputQuestion(
    question: AgentTUIInputQuestion,
  ): Promise<AgentTUIInputQuestionResponse | undefined> {
    const options = question.options ?? [];
    const textOnly = options.length === 0;
    const freeformRow = !textOnly && question.allowFreeform === true;
    const rowCount = options.length + (freeformRow ? 1 : 0);
    const prompt = stripTerminalControls(question.prompt);
    let cursor = 0;
    let editor = EMPTY_LINE;
    const editing = () => textOnly || (freeformRow && cursor === options.length);
    const record = (body: string) =>
      this.#pushBlock({
        kind: "question",
        title: prompt,
        body: `${this.#theme.colors.dim(this.#theme.glyph.elbow)}  ${body}`,
        preformatted: true,
        live: false,
      });

    return await this.#ask<AgentTUIInputQuestionResponse | undefined>((settle) => {
      const answer = (resolved: { optionId?: string; text?: string; label: string }) => {
        record(stripTerminalControls(resolved.label));
        const response: AgentTUIInputQuestionResponse = {};
        if (resolved.optionId !== undefined) response.optionId = resolved.optionId;
        if (resolved.text !== undefined) response.text = resolved.text;
        settle.done(response);
      };
      const dismiss = () => {
        record(this.#theme.colors.dim("Skipped. The question stays open."));
        settle.done(undefined);
      };
      return {
        placement: "drawer",
        caret: editing,
        rows: (width) => {
          const maxRows = this.#terminal.height() - drawerChromeRows;
          if (!textOnly) {
            return this.#drawer(
              renderQuestionPanel(
                {
                  prompt,
                  options,
                  cursor,
                  allowFreeform: freeformRow,
                  editor,
                  caretVisible: this.#caretVisible(),
                  maxRows,
                },
                this.#theme,
                width,
              ),
              "↑/↓ move · enter to select · esc to dismiss",
              width,
              question.context,
            );
          }
          const input = promptInputRows({
            ...editor,
            width: Math.max(1, width - 2),
            theme: this.#theme,
            caretVisible: this.#caretVisible(),
            ghost: "",
            maxRows: 3,
          });
          return this.#drawer(
            fitQuestionPanel(
              [
                ...renderQuestionPrompt(question.prompt, this.#theme, width),
                "",
                ...input.map((row) => `  ${row}`),
              ],
              maxRows,
            ),
            "Enter submit · Esc dismiss",
            width,
            question.context,
          );
        },
        key: (key) => {
          if (key.type === "ctrl-c") {
            if (editing() && editor.text.length > 0) editor = EMPTY_LINE;
            else this.#close();
            return;
          }
          if (key.type === "escape") {
            if (editing() && editor.text.length > 0) editor = EMPTY_LINE;
            else dismiss();
            return;
          }
          if (key.type === "enter") {
            if (!editing()) {
              const option = options[cursor];
              if (option !== undefined) answer({ optionId: option.id, label: option.label });
              return;
            }
            const resolved = resolveQuestionText(editor.text, question);
            if (resolved !== undefined) answer(resolved);
            return;
          }
          if (!textOnly) {
            const intent = setupSelectionIntent(key, { textNavigation: !editing() });
            if (intent?.kind === "move" && rowCount > 0) {
              cursor = (cursor + (intent.direction === "up" ? -1 : 1) + rowCount) % rowCount;
              return;
            }
          }
          if (!editing()) return;
          const edited = this.#killRing.apply(editor, key, { multiline: textOnly });
          if (edited !== undefined) {
            editor = edited;
            return;
          }
          if (textOnly && (key.type === "up" || key.type === "down")) {
            editor = movePromptLine(editor, key.type) ?? editor;
          }
        },
      };
    });
  }

  /** Lets `/help` select a command without leaving a transcript row. */
  async choosePromptCommand(commands: readonly PromptCommandSpec[]): Promise<string | undefined> {
    let state = typeaheadFor(commands, "/");
    const choice = await this.#ask<string | undefined>(
      (settle) => ({
        placement: "panel",
        rows: (width) => {
          const rows = renderCommandSuggestions(state, this.#theme, width);
          const visible = Math.max(1, this.#terminal.height() - 7);
          const start = Math.max(
            0,
            Math.min(state.selectedIndex - visible + 1, rows.length - visible),
          );
          return this.#drawer(
            rows.slice(start, start + visible),
            "↑/↓ move · Enter select · Esc close",
            width,
          );
        },
        key: (key) => {
          if (key.type === "up" || key.type === "ctrl-p") state = moveTypeaheadSelection(state, -1);
          else if (key.type === "down" || key.type === "ctrl-n") {
            state = moveTypeaheadSelection(state, 1);
          } else if (key.type === "enter") {
            const command = selectedTypeaheadCommand(state);
            settle.done(command === undefined ? undefined : typeaheadCompletion(command));
          } else if (key.type === "escape" || key.type === "ctrl-c") settle.done(undefined);
        },
      }),
      () => undefined,
    );
    this.finishCommand({ kind: "dismiss" });
    return choice;
  }

  /** Shows local application metadata without keeping it in the transcript. */
  async showInfoPanel(text: string): Promise<void> {
    const plainText = stripAnsi(text);
    let scroll = 0;
    const visible = () => Math.max(1, this.#terminal.height() - 7);
    const infoRows = (width: number) =>
      plainText
        .split("\n")
        .flatMap((line) =>
          wrapVisibleLine(line, Math.max(1, width - 4)).map((part) => `  ${part}`),
        );
    await this.#ask<void>(
      (settle) => ({
        placement: "panel",
        rows: (width) => {
          const rows = infoRows(width);
          scroll = Math.min(scroll, Math.max(0, rows.length - visible()));
          return this.#drawer(
            rows.slice(scroll, scroll + visible()),
            rows.length > visible() ? "↑/↓ scroll · Esc close" : "Esc to close",
            width,
          );
        },
        key: (key) => {
          if (key.type === "up" || key.type === "ctrl-p") scroll = Math.max(0, scroll - 1);
          else if (key.type === "down" || key.type === "ctrl-n") {
            const rows = infoRows(this.#terminal.width()).length;
            scroll = Math.min(scroll + 1, Math.max(0, rows - visible()));
          } else if (key.type === "escape" || key.type === "ctrl-c" || key.type === "enter") {
            settle.done();
          }
        },
      }),
      () => undefined,
    );
    this.finishCommand({ kind: "dismiss" });
  }

  #drawer(
    body: readonly string[],
    controls: string,
    width: number,
    context?: AgentTUIInputContext,
  ): string[] {
    const label = context === undefined ? undefined : this.#inputContextLabel(context);
    const drawer = renderTransientDrawer(
      body,
      [controls],
      this.#theme,
      width,
      label,
      false,
      "left",
    );
    return [...drawer.rows, ...drawer.controls];
  }

  /** Names the task that asked as its task lines do. */
  #inputContextLabel(context: AgentTUIInputContext): string | undefined {
    if (context.taskId === undefined || context.requester !== undefined || !this.#view) {
      return inputContextLabel(context, this.#theme);
    }
    const requester = this.#transcript.taskLabel(this.#view.conversation, context.taskId);
    return inputContextLabel(
      requester === undefined ? context : { ...context, requester },
      this.#theme,
    );
  }

  // ---------------------------------------------------------------------------
  // Setup flow
  // ---------------------------------------------------------------------------

  /** Opens the setup flow; until it ends, its lines, questions, and status replace the composer. */
  #beginFlow(title: string): void {
    this.#flow = {
      title: stripTerminalControls(title),
      startedAtMs: Date.now(),
      lines: [],
      outputBuffer: [],
    };
    this.#paint();
  }

  #updateFlow(update: (flow: SetupFlowState) => void): void {
    if (this.#flow === undefined) return;
    update(this.#flow);
    this.#paint();
  }

  /**
   * Closes the flow, optionally keeping its warnings and errors. A
   * diagnostic's pulled-in subprocess output persists with it, as one dim
   * block directly above: a failed command must keep its evidence.
   */
  #endFlow(preserveDiagnostics: boolean): void {
    const flow = this.#flow;
    if (flow === undefined) return;
    this.#flow = undefined;
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

  #requireFlow(): SetupFlowState {
    if (this.#flow === undefined) throw new Error("A setup question needs an open setup flow.");
    return this.#flow;
  }

  /**
   * Asks one setup question inside the flow. Ctrl+C both cancels the question
   * and asks the TUI to exit; closing the TUI cancels it.
   */
  #askSetup<T>(
    title: string,
    make: (settle: Settle<T>, flow: SetupFlowState) => Omit<Surface, "placement">,
    cancelled: T,
  ): Promise<T> {
    const flow = this.#requireFlow();
    flow.questionTitle = stripTerminalControls(title);
    // A question means the preceding background operation settled.
    if (flow.status !== undefined) {
      flow.status = undefined;
      flow.summary = undefined;
      flow.preview = undefined;
    }
    return this.#ask<T>(
      (settle) => {
        const surface = make(settle, flow);
        return {
          ...surface,
          placement: "flow",
          key: (key) => {
            if (key.type === "ctrl-c") this.#requestExit();
            surface.key(key);
          },
          dispose: () => {
            surface.dispose?.();
            flow.questionTitle = undefined;
            flow.hideLinesWhileQuestion = false;
          },
        };
      },
      () => cancelled,
    );
  }

  /**
   * One select question. Behavior comes from the shared select reducer
   * (filter, cursor, toggle, locked rows, the multi-select Submit row).
   * Resolves the chosen values, or `undefined` on cancel.
   */
  #readSetupSelect(opts: SetupSelectRequest): Promise<SetupSelectResult> {
    const multiple = opts.kind === "multi" || opts.kind === "searchable-multi";
    const searchAction = opts.kind === "search" ? opts.searchAction : undefined;
    const searchableField = opts.kind === "search" && opts.layout === undefined;
    const planner = opts.navigation?.kind === "planner" ? opts.navigation : undefined;
    const submitRow = multiple && planner === undefined;
    let options: readonly SetupPanelOption[] = opts.options;
    const initial: Parameters<typeof initialSelectState>[0] = { options, searchAction, submitRow };
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

    return this.#askSetup<SetupSelectResult>(
      opts.message,
      (settle, flow) => {
        let notices = opts.notices;
        if (opts.kind === "task-list" || (opts.kind === "search" && opts.layout === "task-list")) {
          const start = flow.taskListLineStart ?? flow.lines.length;
          notices =
            opts.notices ??
            flow.lines
              .slice(start)
              .filter(
                (line): line is FlowPanelLine & { tone: "success" | "warning" | "error" } =>
                  line.tone === "success" || line.tone === "warning" || line.tone === "error",
              )
              .map((line) => ({ tone: line.tone, text: line.text }));
          flow.taskListLineStart = flow.lines.length;
          flow.hideLinesWhileQuestion = true;
        }
        const loadSearch = async (
          query: string,
          load: (query: string) => Promise<readonly SetupPanelOption[]>,
        ) => {
          loading = true;
          error = undefined;
          const version = ++searchVersion;
          try {
            const loaded = await load(query);
            if (version !== searchVersion) return;
            options = loaded;
            select = {
              ...initialSelectState({ options, searchAction, submitRow }),
              filter: select.filter,
            };
          } catch (reason) {
            if (version === searchVersion) error = toErrorMessage(reason);
          } finally {
            if (version === searchVersion) {
              loading = false;
              this.#paint();
            }
          }
        };
        const close = (value: SetupSelectResult) => {
          searchVersion += 1;
          settle.done(value);
        };
        return {
          caret: () => searchableField,
          rows: (width) => {
            const state: Exclude<SetupSelectPanelState, { kind: "actions" }> = {
              ...opts,
              message: "",
              options,
              select,
            };
            if (notices !== undefined && notices.length > 0) state.notices = notices;
            if (error !== undefined) state.error = error;
            if (loading) state.loadingFrame = this.#spinnerFrame();
            if (searchableField) state.caretVisible = this.#caretVisible();
            return renderSelectQuestion(state, this.#theme, width);
          },
          key: (key) => {
            if (loading) {
              if (key.type === "ctrl-c") close(undefined);
              else if (key.type === "escape") {
                searchVersion += 1;
                loading = false;
                select = reduceSelect(
                  select,
                  { type: "clear" },
                  { options, searchAction, submitRow },
                );
              }
              return;
            }
            const first = planner?.firstNavigableStep ?? 0;
            const direction =
              planner !== undefined && key.type === "left" && planner.activeStep > first
                ? "back"
                : planner !== undefined &&
                    key.type === "right" &&
                    planner.activeStep >= first &&
                    planner.activeStep < planner.steps.length - 1
                  ? "forward"
                  : undefined;
            if (direction !== undefined) {
              close({
                kind: "navigate",
                direction,
                values: multiple ? orderedSelection(options, select.selected) : [],
              });
              return;
            }
            const base = { key, options, searchAction, select };
            const result = multiple
              ? reduceSetupSelectInput({
                  ...base,
                  kind: opts.kind,
                  required: opts.required,
                  plannerNavigation: planner !== undefined || undefined,
                })
              : reduceSetupSelectInput({ ...base, kind: opts.kind });
            switch (result.kind) {
              case "cancel":
                close(undefined);
                return;
              case "update":
                select = result.select;
                error = undefined;
                return;
              case "submit": {
                const query = searchActionQuery(result.values[0] ?? "");
                const load = searchAction?.load;
                if (query === undefined || load === undefined) close(result.values);
                else void loadSearch(query, load);
                return;
              }
              case "error":
                error = result.message;
                return;
              default:
                return;
            }
          },
        };
      },
      undefined,
    );
  }

  /**
   * An inert context row and an action menu beside the live flow status.
   * Returns at once with a `close()` so the caller can dismiss it when a
   * concurrent wait wins.
   */
  #readSetupChoice(
    opts: Parameters<SetupFlowRenderer["readChoice"]>[0],
  ): ReturnType<SetupFlowRenderer["readChoice"]> {
    const flow = this.#requireFlow();
    flow.status = { text: stripTerminalControls(opts.status), startedAtMs: Date.now() };
    // Nothing is preselected, so Enter cannot fire "Try again" by reflex.
    let cursor: number | undefined;
    let close!: () => void;
    const choice = this.#ask<string | undefined>(
      (settle) => {
        close = () => settle.done(undefined);
        return {
          placement: "flow",
          rows: (width) =>
            renderSelectQuestion(
              { kind: "actions", context: opts.context, actions: opts.actions, cursor },
              this.#theme,
              width,
            ),
          key: (key) => {
            if (key.type === "ctrl-c") this.#requestExit();
            const intent = setupSelectionIntent(key, { textNavigation: true });
            if (intent?.kind === "cancel") settle.done(undefined);
            else if (intent?.kind === "move") {
              const count = opts.actions.length;
              if (count === 0) return;
              const delta = intent.direction === "down" ? 1 : -1;
              cursor =
                cursor === undefined
                  ? intent.direction === "down"
                    ? 0
                    : count - 1
                  : (cursor + delta + count) % count;
            } else if (intent?.kind === "submit" && cursor !== undefined) {
              settle.done(opts.actions[cursor]!.value);
            }
          },
          dispose: () => {
            flow.status = undefined;
          },
        };
      },
      () => undefined,
    );
    return { choice, close: () => close() };
  }

  #readSetupEditableSelect(
    opts: Parameters<SetupFlowRenderer["readEditableSelect"]>[0],
  ): Promise<SetupEditableSelectResult | undefined> {
    const initial: Parameters<typeof initialSelectState>[0] = { options: opts.options };
    if (opts.initialValue !== undefined) initial.defaultValue = opts.initialValue;
    let select = initialSelectState(initial);
    let editor = lineOf("");
    let error: string | undefined;
    // Hovering the editable row makes it a live field, empty until typing starts.
    const onEditableRow = () =>
      selectValueAtCursor([...opts.options], select.cursor) === opts.editable.value;

    return this.#askSetup<SetupEditableSelectResult | undefined>(
      opts.message,
      (settle) => ({
        caret: onEditableRow,
        rows: (width) => {
          const state: SetupSelectPanelState = {
            kind: "inline-edit",
            layout: "task-list",
            message: "",
            options: opts.options,
            select,
            edit: {
              optionValue: opts.editable.value,
              caretVisible: this.#caretVisible(),
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
        },
        key: (key) => {
          const intent = setupSelectionIntent(key, { textNavigation: !onEditableRow() });
          if (intent?.kind === "cancel") {
            settle.done(undefined);
            return;
          }
          if (intent?.kind === "move") {
            select = reduceSelect(select, { type: intent.direction }, { options: opts.options });
            error = undefined;
            if (!onEditableRow()) editor = lineOf("");
            return;
          }
          if (intent?.kind === "submit") {
            const value = selectValueAtCursor([...opts.options], select.cursor);
            if (value === undefined) return;
            if (value !== opts.editable.value) {
              settle.done({ kind: "selected", value });
              return;
            }
            const text = (editor.text || opts.editable.defaultValue).trim();
            error = opts.editable.validate?.(text);
            if (error !== undefined) return;
            settle.done(
              text === opts.editable.defaultValue
                ? { kind: "selected", value }
                : { kind: "edited", value, text },
            );
            return;
          }
          if (!onEditableRow()) return;
          const edited = this.#killRing.apply(editor, key);
          if (edited !== undefined) {
            editor = edited;
            error = undefined;
          }
        },
      }),
      undefined,
    );
  }

  #readProviderPicker(opts: ProviderPickerRequest): Promise<ProviderPickerChoice | undefined> {
    this.#killRing.clear();
    let interaction = initialProviderPickerState(opts.options, opts.initialValue);
    let validation: AbortController | undefined;
    const editing = () =>
      interaction.phase.kind === "editing" || interaction.phase.kind === "invalid";

    return this.#askSetup<ProviderPickerChoice | undefined>(
      opts.message,
      (settle) => {
        const dispatch = (event: ProviderPickerEvent) => {
          const transition = transitionProviderPicker(interaction, event, opts.options);
          switch (transition.kind) {
            case "ignore":
              return;
            case "cancel":
              settle.done(undefined);
              return;
            case "settle":
              settle.done(transition.result);
              return;
            case "clear":
              validation?.abort();
              validation = undefined;
              interaction = transition.state;
              return;
            case "render":
              interaction = transition.state;
              return;
            case "validate": {
              interaction = transition.state;
              const controller = new AbortController();
              validation = controller;
              let result: ReturnType<typeof opts.validateInlineKey>;
              try {
                result = opts.validateInlineKey(transition.key, controller.signal);
              } catch (error) {
                settle.fail(error);
                return;
              }
              void result.then(
                (outcome) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  dispatch({ type: "validated", validation: outcome });
                  this.#paint();
                },
                (error: unknown) => {
                  if (validation !== controller || controller.signal.aborted) return;
                  validation = undefined;
                  settle.fail(error);
                },
              );
              return;
            }
          }
        };
        return {
          caret: editing,
          rows: (width) => {
            // The cursor row's Enter affordance: `↵ change` on the active provider.
            let badge: string | undefined;
            if (interaction.phase.kind === "inactive") {
              const value = selectValueAtCursor([...opts.options], interaction.select.cursor);
              const row = opts.options.find((option) => option.value === value);
              if (row !== undefined) {
                badge = enterBadge(this.#theme, row.checked === true ? "change" : undefined);
              }
            }
            const panel: SetupSelectPanelState = {
              kind: "inline-edit",
              layout: "stacked",
              message: "",
              options: opts.options,
              select: interaction.select,
              edit: {
                optionValue: "ai-gateway-key",
                caretVisible: this.#caretVisible(),
                editor: { kind: "key", phase: interaction.phase },
              },
            };
            if (badge !== undefined) panel.cursorBadge = badge;
            return renderSelectQuestion(panel, this.#theme, width);
          },
          key: (key) => {
            const intent = setupSelectionIntent(key, {
              textNavigation: interaction.phase.kind === "inactive",
            });
            if (intent?.kind === "cancel") dispatch({ type: "cancel" });
            else if (intent?.kind === "move")
              dispatch({ type: "move", direction: intent.direction });
            else if (intent?.kind === "submit") dispatch({ type: "submit" });
            else if (editing() && "editor" in interaction.phase) {
              // Provider credentials must never enter the session kill ring.
              const edited = applyLineEditorKey(interaction.phase.editor, key);
              if (edited !== undefined) dispatch({ type: "edit", editor: edited });
            }
          },
          dispose: () => {
            validation?.abort();
            validation = undefined;
          },
        };
      },
      undefined,
    );
  }

  /**
   * One text question. `mask` renders bullets; `validate` keeps the prompt
   * open with its message. Resolves the value (the default when empty), or
   * `undefined` on cancel.
   */
  #readSetupText(opts: Parameters<SetupFlowRenderer["readText"]>[0]): Promise<string | undefined> {
    if (opts.mask === true) this.#killRing.clear();
    let editor: LineState = lineOf("");
    let error: string | undefined;
    return this.#askSetup<string | undefined>(
      opts.message,
      (settle) => ({
        caret: () => true,
        rows: (width) => {
          const state: Parameters<typeof renderTextQuestion>[0] = {
            message: "",
            editor,
            mask: opts.mask === true,
          };
          const placeholder = opts.placeholder ?? opts.defaultValue;
          if (placeholder !== undefined) state.placeholder = placeholder;
          if (opts.notices !== undefined) state.notices = opts.notices;
          if (error !== undefined) state.error = error;
          return renderTextQuestion(state, this.#theme, width, this.#caretVisible());
        },
        key: (key) => {
          const edited = opts.mask
            ? applyLineEditorKey(editor, key)
            : this.#killRing.apply(editor, key);
          if (edited !== undefined) {
            editor = edited;
            error = undefined;
          } else if (key.type === "ctrl-c" || key.type === "escape") {
            settle.done(undefined);
          } else if (key.type === "enter") {
            const value = editor.text.length > 0 ? editor.text : (opts.defaultValue ?? "");
            error = opts.validate?.(value);
            if (error === undefined) settle.done(value);
          }
        },
      }),
      undefined,
    );
  }

  /** Static instructions held in the flow until Enter or Esc. */
  #readSetupAcknowledge(opts: { message: string; lines: readonly string[] }): Promise<void> {
    return this.#askSetup<void>(
      opts.message,
      (settle) => ({
        rows: (width) =>
          renderAcknowledgeQuestion({ message: "", lines: opts.lines }, this.#theme, width),
        key: (key) => {
          if (key.type === "enter" || key.type === "escape" || key.type === "ctrl-c") settle.done();
        },
      }),
      undefined,
    );
  }

  /** See {@link SetupFlowRenderer.waitForInterrupt}: a key trap under the flow's questions. */
  #waitForFlowInterrupt(options?: { interruptible?: boolean }): {
    promise: Promise<SetupFlowInterrupt>;
    dispose(): void;
  } {
    const interruptible = options?.interruptible ?? true;
    let dispose!: () => void;
    const promise = this.#ask<SetupFlowInterrupt>(
      (settle) => {
        const surface: Surface = {
          key: (key) => {
            if (!interruptible || (key.type !== "ctrl-c" && key.type !== "escape")) return;
            if (key.type === "ctrl-c") this.#requestExit();
            settle.done(key.type === "ctrl-c" ? "ctrl-c" : "escape");
          },
        };
        // Disposal pops the trap without settling, so the promise never resolves.
        dispose = () => this.#dropSurface(surface);
        return surface;
      },
      () => "ctrl-c",
    );
    return { promise, dispose: () => dispose() };
  }

  /** Pops a surface without settling it. */
  #dropSurface(surface: Surface): void {
    const index = this.#stack.findIndex((entry) => entry.surface === surface);
    if (index === -1) return;
    this.#stack.splice(index, 1);
    this.#paint();
  }

  /**
   * The flow's one-line loading state; `undefined` clears it. With no flow
   * open it shows above the prompt instead.
   */
  #setFlowStatus(status: string | undefined): void {
    const text = status === undefined ? undefined : stripTerminalControls(status);
    if (this.#flow !== undefined) {
      this.#flow.status = text === undefined ? undefined : { text, startedAtMs: Date.now() };
      if (text === undefined) this.#flow.preview = undefined;
    } else {
      this.#flowlessStatus = text;
    }
    this.#paint();
  }

  /** Records one flow line; outside a flow it commits to the transcript. */
  #renderFlowLine(text: string, tone: "info" | "success" | "warning" | "error"): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#flow;
    if (flow === undefined) {
      this.#pushBlock({ kind: "flow", title: tone, body: content, live: false });
      this.#paint();
      return;
    }
    // A line settles the output preview; a warning or error first pulls the
    // buffered subprocess output in as its evidence.
    flow.preview = undefined;
    if (tone === "warning" || tone === "error") {
      for (const buffered of flow.outputBuffer) {
        flow.lines.push({ text: buffered, tone: "info", evidence: true });
      }
    }
    flow.outputBuffer = [];
    flow.lines.push({ text: content, tone });
    this.#paint();
  }

  #replaceFlowContent(content?: {
    headline: string;
    facts: readonly { label: string; value: string }[];
  }): void {
    this.#updateFlow((flow) => {
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
    });
  }

  /** One line of subprocess output: a transient preview, kept briefly as possible evidence. */
  #renderFlowOutput(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return;
    const flow = this.#flow;
    if (flow === undefined) {
      this.#renderFlowLine(content, "info");
      return;
    }
    flow.preview = content;
    flow.outputBuffer.push(content);
    if (flow.outputBuffer.length > FLOW_OUTPUT_BUFFER_CAP) flow.outputBuffer.shift();
    this.#paint();
  }

  /** Gives an interactive subprocess the screen, then restores the transcript. */
  async #withInheritedStdio<T>(task: () => Promise<T>): Promise<T> {
    this.#suspended = true;
    this.#stopTicker();
    try {
      return await this.#terminal.suspend(task);
    } finally {
      this.#suspended = false;
      this.#lastFrame = undefined;
      this.#paint();
    }
  }

  // ---------------------------------------------------------------------------
  // Trace viewer (alternate screen)
  // ---------------------------------------------------------------------------

  async #openTraceViewer(options: TraceViewerOpenOptions): Promise<void> {
    if (this.#traceView !== undefined || !this.#terminal.active) return;
    const alt = this.#terminal.alt;
    const session = new TraceViewerSession({
      ...options,
      theme: this.#theme,
      dimensions: () => ({ width: this.#terminal.width(), height: this.#terminal.height() }),
      paint: (rows) => alt.paint(rows, this.#terminal.height()),
      tracingDisabled: process.env.EVE_TRACES === "off",
      copyText: (text) => copyTextToClipboard(text, (chunk) => alt.writeRaw(chunk)),
      terminalBackground: this.#terminalBackground,
    });
    this.#traceView = session;
    alt.enter();
    // The viewer derives card surfaces from the terminal's own background;
    // terminals that never answer leave it on its plain rendering.
    if (this.#theme.color) alt.writeRaw(BACKGROUND_COLOR_QUERY);
    await this.#ask<void>(
      (settle) => {
        session.start();
        return {
          key: (key) => {
            if (session.handleKey(key) === "close") settle.done();
          },
          dispose: () => {
            this.#traceView = undefined;
            session.dispose();
            alt.exit();
            this.#terminal.live.hideCursor();
            this.#lastFrame = undefined;
          },
        };
      },
      () => undefined,
    );
  }

  // ---------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------

  #paint(): void {
    if (!this.#terminal.active || this.#suspended) return;
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
    this.#syncTicker();
  }

  #paintNow(): void {
    if (this.#traceView !== undefined) {
      this.#traceView.repaint();
      return;
    }
    const width = this.#terminal.width();
    const committed = this.#pendingRows;
    this.#pendingRows = [];
    let previous = this.#lastCommitted;

    // The settled prefix moves to scrollback. Groups are contiguous runs, so
    // committing a group commits exactly its members.
    const groups = groupToolBlocksForDisplay(this.#blocks);
    let settledGroups = 0;
    let settledBlocks = 0;
    for (const group of groups) {
      if (group.display.live !== false) break;
      settledGroups += 1;
      settledBlocks += group.members.length;
      committed.push(...this.#renderBlock(group.display, width, previous));
      previous = previousBlockOf(group.display);
      for (const member of group.members) {
        if (member.id === undefined) continue;
        if (this.#conversationBlockIds.has(member.id)) this.#committedIds.add(member.id);
        this.#blockById.delete(member.id);
      }
    }
    this.#blocks.splice(0, settledBlocks);
    this.#lastCommitted = previous;

    // Live rows are never partially committed: they may rewrap or grow next paint.
    const footer = this.#footerRows(width);
    const startupHeader =
      this.#startupPhase !== undefined && this.#agentHeaderBody === undefined
        ? this.#agentHeaderRows()
        : [];
    const live: string[] = [];
    for (const { display } of groups.slice(settledGroups)) {
      live.push(...this.#renderBlock(display, width, previous));
      previous = previousBlockOf(display);
    }
    const maxLiveRows = Math.max(0, this.#terminal.height() - startupHeader.length - footer.length);
    const rows = [
      ...startupHeader,
      ...clipLiveRows(live, maxLiveRows, width, this.#theme),
      ...footer,
    ];
    const frame = rows.join("\n");
    if (committed.length === 0 && frame === this.#lastFrame) return;
    this.#lastFrame = frame;
    this.#terminal.live.flush(committed, rows);
  }

  #renderBlock(block: DisplayBlock, width: number, previous: PreviousBlock | undefined): string[] {
    const context: Parameters<typeof renderBlockLines>[3] = {
      renderMarkdown: this.#renderMarkdown,
      activityPulse: this.#pulse(this.#activityPulseStartedAtMs),
    };
    if (previous !== undefined) context.previous = previous;
    if (this.#flow !== undefined) context.setupFlowOpen = true;
    if (this.#stack.some((entry) => entry.surface.placement === "panel")) {
      context.transientPanelOpen = true;
    }
    const rows = renderBlockLines(block, width, this.#theme, context);
    return (block.depth ?? 0) === 0 && leadsWithGap(block, previous) ? ["", ...rows] : rows;
  }

  #agentHeaderRows(): string[] {
    const input: Parameters<typeof buildAgentHeader>[0] = {
      name: this.#agentHeader?.name ?? this.#title,
      theme: this.#theme,
      width: this.#terminal.width(),
    };
    if (this.#agentHeader?.info !== undefined) input.info = this.#agentHeader.info;
    return buildAgentHeader(input);
  }

  #footerRows(width: number): string[] {
    if (this.#flow !== undefined) return this.#flowRows(this.#flow, width);
    const surface = this.#stack.findLast((entry) => entry.surface.rows !== undefined)?.surface;
    if (surface?.placement === "panel") return surface.rows!(width);
    if (surface?.placement === "drawer") {
      // The request keeps priority; task activity uses what height remains.
      const drawer = surface.rows!(width);
      const available = this.#terminal.height() - drawer.length - 1;
      const activity = available >= 4 ? this.#taskPanelRows(width, available + 1) : [];
      return [...activity.slice(0, -1), ...drawer].map((row) => clipVisible(row, width));
    }
    return this.#composerRows(width);
  }

  #composerRows(width: number): string[] {
    const c = this.#theme.colors;
    const rows: string[] = [""];
    if (this.#startupPhase === undefined && this.#setupAttention !== undefined) {
      rows.push(...renderAttentionRows(this.#setupAttention, width, this.#theme), "");
    }
    const working = this.#view?.working === true;
    const tasks = this.#taskPanelRows(width);
    rows.push(...tasks);
    if (working) {
      if (tasks.length === 0) rows.push(this.#turnBar(width));
      if (this.#composer.cancelRequested) {
        rows.push(
          clipVisible(
            `${c.yellow(this.#theme.glyph.dotActive)} ${c.dim("Cancelling turn… · Ctrl+C to stop waiting, then again to exit")}`,
            width,
          ),
        );
      }
      if (tasks.length === 0 || this.#composer.cancelRequested) rows.push("");
    } else if (this.#flowlessStatus !== undefined) {
      const pulse = this.#pulse(this.#activityPulseStartedAtMs);
      rows.push(clipVisible(c.dim(`${pulse} ${this.#flowlessStatus}`), width), "");
    }
    // Messages sent while the agent starts wait here until the runner reads them.
    if (this.#startupPhase !== undefined) {
      const queued = this.#inputs.flatMap((input) => (input.type === "submit" ? [input.text] : []));
      for (const text of queued) {
        rows.push(clipVisible(c.dim(`${this.#theme.glyph.dot} Queued: ${firstLine(text)}`), width));
      }
      if (queued.length > 0) rows.push("");
    }
    if (this.#composer.exitArmed)
      rows.push(clipVisible(c.dim("Press Ctrl+C again to exit"), width), "");

    const drawer = this.#composer.drawerRows(width);
    const status = this.#statusLine(width);
    const rule = c.dim(this.#theme.glyph.dash.repeat(width));
    // Keep one transcript row above the footer and one separator below the prompt.
    const maxRows = Math.max(
      1,
      this.#terminal.height() -
        2 -
        rows.length -
        drawer.length -
        status.length -
        (drawer.length > 0 ? 2 : 1),
    );
    rows.push(
      ...this.#composer.promptRows({
        width,
        maxRows,
        caretVisible: this.#stack.length === 0 && this.#caretVisible(),
        placeholder: this.#hasUserMessage || working ? "" : this.#initialPromptPlaceholder,
      }),
    );
    // Menus sit beneath the composer so opening one never moves the caret.
    if (drawer.length > 0) rows.push(rule, ...drawer);
    if (status.length > 0) rows.push(drawer.length > 0 ? rule : "", ...status);
    else if (drawer.length === 0) rows.push("");
    return rows;
  }

  #flowRows(flow: SetupFlowState, width: number): string[] {
    const indicator = { glyph: this.#pulse(flow.startedAtMs) };
    let status: FlowPanelStatus | undefined;
    if (flow.status !== undefined) {
      const elapsedMs = Date.now() - flow.status.startedAtMs;
      const elapsed = elapsedMs >= 5_000 ? ` ${formatTurnDuration(elapsedMs)}` : "";
      status = { text: `${flow.status.text}${elapsed}`, indicator };
    }
    const question = this.#stack.findLast((entry) => entry.surface.placement === "flow")?.surface;
    let content: FlowPanelContent;
    if (question !== undefined) {
      const rows = question.rows!(width);
      content =
        status === undefined
          ? { kind: "question", title: flow.questionTitle, rows }
          : { kind: "question", title: flow.questionTitle, rows, status };
    } else if (status !== undefined) {
      content =
        flow.preview === undefined
          ? { kind: "status", status }
          : { kind: "status", status, preview: flow.preview };
    } else if (flow.preview !== undefined) {
      content = { kind: "preview", text: flow.preview, indicator };
    } else {
      content = { kind: "idle", indicator };
    }
    const lines: FlowPanelLine[] =
      flow.summary !== undefined
        ? [
            { text: flow.summary.headline, tone: "success" },
            ...flow.summary.facts.map((fact) => ({
              text: `${fact.label}: ${fact.value}`,
              tone: "info" as const,
            })),
          ]
        : flow.hideLinesWhileQuestion === true
          ? []
          : flow.lines;
    const drawer = renderFlowDrawer(
      { title: flow.title, navigation: flow.navigation, lines, content },
      this.#theme,
      width,
    );
    // No status line under the flow: the flow mutates the very state it shows.
    const rows = [...drawer.rows, ...drawer.controls];
    if (this.#remoteConnection !== undefined) {
      const line = buildStatusLine({
        remote: this.#remoteConnection,
        theme: this.#theme,
        width: Math.max(1, width - STATUS_LINE_LEFT_PADDING.length),
      });
      if (line !== undefined)
        rows.push("", clipVisible(`${STATUS_LINE_LEFT_PADDING}${line}`, width));
    }
    return rows;
  }

  #taskPanelRows(
    width: number,
    maxRows = Math.max(8, Math.floor(this.#terminal.height() / 2)),
  ): string[] {
    const tasks = this.#transcript.tasks;
    if (tasks.length === 0) return [];
    const now = Date.now();
    const working = this.#view?.working === true;
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

  /** The one live turn bar above the composer; the end-of-turn coda is its settled form. */
  #turnBar(width: number): string {
    const elapsedMs = Math.max(0, Date.now() - (this.#turnClock.startedAtMs ?? Date.now()));
    const marker = elapsedMs % 1000 < 500 ? (this.#theme.unicode ? "•" : "*") : " ";
    const elapsed =
      elapsedMs < 1000 ? "0s" : formatTurnDuration(Math.floor(elapsedMs / 1000) * 1000);
    const activity =
      this.#view === undefined ? "Thinking" : turnActivity(this.#view, this.#transcript.tasks);
    const usage = this.#turnClock.usage(this.#usage());
    const tokens =
      usage.inputTokens > 0 || usage.outputTokens > 0
        ? this.#theme.colors.dim(` (${formatTokenFlow(usage, this.#theme.glyph)})`)
        : "";
    return clipVisible(`${marker} ${activity} (${elapsed})${tokens}`, width);
  }

  /** The persistent bottom status line, or the startup progress while the agent starts. */
  #statusLine(width: number): string[] {
    if (this.#startupPhase !== undefined) {
      const label = {
        starting: "Starting agent…",
        connecting: "Reading saved connection…",
        updating: "Loading selected model…",
      }[this.#startupPhase];
      const pulse = this.#pulse(this.#startupStartedAt);
      return [clipVisible(this.#theme.colors.dim(`${pulse} ${label}`), width)];
    }
    const padding = this.#remoteConnection === undefined ? "" : STATUS_LINE_LEFT_PADDING;
    const input: Parameters<typeof buildStatusLine>[0] = {
      theme: this.#theme,
      width: Math.max(1, width - padding.length),
    };
    const build = this.#visibleBuild();
    if (build !== undefined) input.devBuild = build;
    if (Date.now() < this.#logHintUntil) input.logLevel = this.#logs;
    const model = this.#agentHeader?.info?.agent.model;
    if (model?.routing.kind === "dynamic") {
      input.dynamicModel = true;
      const modelId = this.#view?.data.modelId;
      if (modelId !== undefined) input.model = modelId;
    } else if (model?.id !== undefined) input.model = model.id;
    // "provider-default" is the absent-setting sentinel, not a level worth showing.
    if (model?.reasoning !== undefined && model.reasoning !== "provider-default") {
      input.reasoning = model.reasoning;
    }
    if (readGatewayServiceTier(model?.providerOptions).kind === "priority") input.fastMode = true;
    if (model?.endpoint !== undefined) input.endpoint = model.endpoint;
    if (this.#vercelStatus !== undefined) input.vercel = this.#vercelStatus;
    if (this.#remoteConnection !== undefined) input.remote = this.#remoteConnection;
    const line = buildStatusLine(input);
    return line === undefined ? [] : [clipVisible(`${padding}${line}`, width)];
  }

  // ---------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------

  #caretVisible(): boolean {
    return Math.floor((Date.now() - this.#caretEpoch) / caretBlinkMs) % 2 === 0;
  }

  #spinnerFrame(): string {
    return this.#theme.spinner[this.#spinnerIndex % this.#theme.spinner.length] ?? "";
  }

  #pulse(startedAtMs: number): string {
    return isProgressPulseVisible(Date.now() - startedAtMs)
      ? this.#theme.unicode
        ? PROGRESS_PULSE_GLYPH
        : PROGRESS_PULSE_ASCII_GLYPH
      : " ";
  }

  /** Whether anything on screen moves with time, so the ticker runs fast. */
  #animating(): boolean {
    const now = Date.now();
    return (
      this.#startupPhase !== undefined ||
      this.#flow !== undefined ||
      this.#flowlessStatus !== undefined ||
      this.#view?.working === true ||
      this.#transcript.tasks.length > 0 ||
      this.#pendingCommandEcho !== undefined ||
      this.#composer.loading() ||
      now < this.#logHintUntil ||
      (this.#build !== undefined &&
        (this.#build.status.phase === "building" ||
          now - this.#build.atMs < devBuildLoadedStatusMs))
    );
  }

  /** One ticker drives every animation: fast while something moves, slow for a blinking caret. */
  #syncTicker(): void {
    const top = this.#stack.at(-1)?.surface;
    const caret = top === undefined ? this.#flow === undefined : top.caret?.() === true;
    const period = this.#closed ? 0 : this.#animating() ? tickMs : caret ? caretBlinkMs : 0;
    if (this.#ticker?.period === period) return;
    this.#stopTicker();
    if (period === 0) return;
    const timer = setInterval(() => {
      this.#spinnerIndex += 1;
      this.#paint();
    }, period);
    timer.unref?.();
    this.#ticker = { timer, period };
  }

  #stopTicker(): void {
    if (this.#ticker === undefined) return;
    clearInterval(this.#ticker.timer);
    this.#ticker = undefined;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function previousBlockOf(block: Block): PreviousBlock {
  const previous: PreviousBlock = { kind: block.kind };
  if (block.title !== undefined) previous.title = block.title;
  if (block.subagentCallId !== undefined) previous.subagentCallId = block.subagentCallId;
  return previous;
}

/**
 * Whether a block gets a blank line above it. Speakers always breathe; a tool
 * run breathes after whoever spoke last and stays tight within the run.
 */
function leadsWithGap(block: Block, previous: PreviousBlock | undefined): boolean {
  if (
    (block.kind === "tool" || block.kind === "task") &&
    (previous?.kind === "user" || previous?.kind === "assistant" || previous?.kind === "question")
  ) {
    return true;
  }
  if (block.kind === "sandbox") return previous?.kind !== "sandbox";
  if (previous?.kind === "sandbox" || previous?.kind === "log") return true;
  switch (block.kind) {
    case "tool":
    case "task":
    case "result":
    case "subagent-step":
    case "subagent-tool":
      return false;
    default:
      return true;
  }
}

function firstLine(text: string): string {
  const [line = ""] = stripTerminalControls(text).split("\n");
  return line;
}

function clipLiveRows(
  rows: readonly string[],
  maxRows: number,
  width: number,
  theme: Theme,
): string[] {
  if (maxRows <= 0) return [];
  if (rows.length <= maxRows) return [...rows];
  const tail = maxRows - 1;
  const hidden = rows.length - tail;
  const marker = theme.colors.dim(
    `${theme.glyph.dot} ${theme.glyph.ellipsis} ${hidden.toLocaleString()} earlier ${hidden === 1 ? "row" : "rows"} hidden while streaming`,
  );
  return [clipVisible(marker, width), ...rows.slice(rows.length - tail)];
}

function resolveQuestionText(
  rawText: string,
  question: AgentTUIInputQuestion,
): { optionId?: string; text?: string; label: string } | undefined {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return undefined;
  const options = question.options ?? [];
  const matched = matchQuestionOption(trimmed.toLowerCase(), options);
  if (matched !== undefined) return { optionId: matched.id, label: matched.label };
  const acceptsFreeform = question.allowFreeform === true || options.length === 0;
  return acceptsFreeform ? { text: trimmed, label: trimmed } : undefined;
}

function matchQuestionOption(
  normalized: string,
  options: ReadonlyArray<AgentTUIInputOption>,
): AgentTUIInputOption | undefined {
  const byId = options.find((option) => option.id.toLowerCase() === normalized);
  if (byId !== undefined) return byId;
  const byLabel = options.find((option) => option.label.toLowerCase() === normalized);
  if (byLabel !== undefined) return byLabel;
  const index = Number(normalized);
  return Number.isInteger(index) && index > 0 && index <= options.length
    ? options[index - 1]
    : undefined;
}
