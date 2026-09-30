/**
 * The transcript block model and its renderer.
 *
 * A {@link Block} is one logical unit of the conversation — a user message, a
 * streamed assistant reply, a reasoning trace, a tool call, a task starting
 * or ending, a log line, and so on. {@link renderBlockLines} turns a block into the
 * exact terminal rows it occupies: a colored gutter glyph, brand-aligned
 * indentation, nesting rules for an agent's own rows, and word-wrapped content — with no
 * boxes anywhere. Every returned row is already styled and fits within the
 * given width, so the live region can place rows verbatim.
 */

import { renderMarkdown } from "./markdown.js";
import type { ToolDetailLine } from "./line-diff.js";
import type { TaskKind } from "./task-activity.js";
import type { Theme } from "./theme.js";
import type { ToolGroupPresentation } from "./tool-presentation.js";
import { isPromptControlCommand } from "./prompt-commands.js";
import { renderTool } from "./tool-rows.js";
import { truncate } from "./tool-format.js";
import { elisionText, TOOL_COLUMN_LEAD } from "./rail.js";
import {
  clipVisible,
  sliceVisible,
  visibleLength,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";

export type ToolStatus = "running" | "done" | "error" | "denied" | "approval";

export type BlockKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "error"
  | "notice"
  | "warning"
  | "result"
  | "flow"
  | "command"
  | "question"
  | "task"
  | "subagent-step"
  | "subagent-tool"
  | "connection-auth"
  | "sandbox"
  | "log"
  | "turn-stats"
  | "session-boundary"
  | "agent-header";

/**
 * One renderable transcript unit. Fields are interpreted per `kind`; unset
 * fields are simply omitted from the rendered output.
 */
export interface Block {
  kind: BlockKind;
  /** Stable id for in-place updates while the block is live. */
  id?: string;
  /** Nesting depth: 0 = top level, 1 = an agent's own row, etc. */
  depth?: number;
  /** Whether the block is still streaming / mutating (drives the activity pulse). */
  live?: boolean;

  /** Primary label — tool name, task name, log source, error title. */
  title?: string;
  /** Past-tense tool label swapped in once the call settles successfully. */
  doneTitle?: string;
  /** Compact secondary text — summarized tool args. */
  subtitle?: string;
  /** Main multi-line content (markdown for prose, plain for logs). */
  body?: string;
  /** User blocks only: steered messages use a yellow gutter. */
  promptOrigin?: "steer" | "queue";
  /** Reasoning trace shown above `body` (subagent steps). */
  reasoning?: string;
  /** One-line summarized result shown after a tool resolves. */
  result?: string;
  /**
   * Errors only: multi-line diagnostic dump (stack trace, cause chain)
   * rendered dim beneath the headline, capped to a handful of lines.
   */
  detail?: string;
  /** Structured remediation shown between an error's body and its detail. */
  hint?: string;

  /**
   * Tool, connection, or completed command lifecycle status. A task line
   * without one marks the task starting; `done`, `error`, and `denied`
   * (stopped) mark it ending.
   */
  status?: ToolStatus;
  /** When true, treat `body` as pre-styled and only wrap + indent it. */
  preformatted?: boolean;
  /** Reasoning only: collapse the trace to a single "thinking" line. */
  collapsed?: boolean;
  /** When true, expand tool input/output instead of summarizing. */
  expanded?: boolean;
  /** Captured-log visibility used for concise-vs-raw diagnostic replay. */
  logVisibility?: "stderr-only" | "all-only";
  /** Raw tool input / output for the expanded view. */
  toolInput?: unknown;
  toolOutput?: unknown;
  /** Original execution name, kept separate from a semantic display title. */
  toolName?: string;
  /** Optional aggregation metadata; execution state remains on this call's block. */
  toolGroup?: ToolGroupPresentation;
  /** Salient body lines rendered behind the `│` rail under the tool header. */
  detailLines?: readonly ToolDetailLine[];
  /** When true, `detailLines` stay visible after the call settles (writes). */
  keepDetailWhenDone?: boolean;
  /** The agent call an agent's own row belongs to. */
  subagentCallId?: string;
  /** The agent an agent's own row belongs to, named above its first row. */
  agentName?: string;
  /** Task lines only: whether an agent or a tool does the work. */
  taskKind?: TaskKind;
  /**
   * Monotonic activity stamp, bumped on every push and in-place update.
   * Recency windows key on it so a parallel-announced call that just
   * settled counts as newer than a later-announced one still idle.
   */
  updateSeq?: number;
}

/**
 * What the renderers actually draw: an execution {@link Block} plus the
 * synthesized presentation the display grouping may attach. Only the
 * grouping layer creates these fields, so an execution block can never
 * smuggle display state — the type boundary enforces what used to be a
 * comment.
 */
export interface DisplayBlock extends Block {
  /** Items listed when equivalent tool calls are coalesced into one row. */
  toolGroupItems?: readonly ToolGroupItem[];
  /** Earlier captured writes merged into this log section; renders as `… +N more`. */
  elided?: number;
}

/** One coalesced call's row beneath an aggregated tool header. */
export interface ToolGroupItem {
  readonly text: string;
  /** Per-call failure summary, present when a failed batch is aggregated. */
  readonly result?: string;
}

export interface RenderBlockContext {
  /** Current shared square-pulse frame for live activity blocks. */
  activityPulse: string;
  /** An open setup panel owns the pulse, so a running command's gutter holds still. */
  setupFlowOpen?: boolean;
  /** A transient panel keeps its command echo live without a progress glyph. */
  transientPanelOpen?: boolean;
  /** Whether prose responses are parsed and styled as Markdown. */
  renderMarkdown?: boolean;
  /**
   * Kind and title of the block rendered immediately above this one. Lets a
   * sandbox block detect that it continues a run (label suppressed, lines
   * hang under the previous block's label) without any mutable run state —
   * each captured write stays its own immediately-committed block.
   */
  previous?: { kind: BlockKind; title?: string; subagentCallId?: string };
}

/**
 * Renders a block to its terminal rows. Each row is fully styled and clipped
 * to `width` visible columns.
 */
export function renderBlockLines(
  block: DisplayBlock,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const depth = block.depth ?? 0;
  const prefix = nestingPrefix(depth, theme);
  const avail = Math.max(8, width - visibleLength(prefix));
  const rows = renderBody(block, avail, theme, context).map((row) => `${prefix}${row}`);
  // An agent's own rows interleave with everything else in the order they
  // finish, so each run of them opens with the agent's name.
  if (
    block.agentName !== undefined &&
    context.previous?.subagentCallId !== block.subagentCallId &&
    rows.length > 0
  ) {
    const name = `${theme.colors.orange(theme.glyph.subagent)} ${theme.colors.dim(block.agentName)}`;
    return [clipVisible(`${TOOL_COLUMN_LEAD}${name}`, width), ...rows];
  }
  return rows;
}

/**
 * The gutter prefix for nested rows: the two-cell tool-column indent, then a
 * dim vertical rule per nesting level beneath the agent's name.
 */
function nestingPrefix(depth: number, theme: Theme): string {
  if (depth <= 0) return "";
  const rule = `${theme.colors.dim(theme.glyph.rule)} `;
  return `${TOOL_COLUMN_LEAD}${rule.repeat(depth)}`;
}

function renderBody(
  block: DisplayBlock,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  switch (block.kind) {
    case "user":
      return renderUser(block, width, theme);
    case "assistant":
    case "subagent-step":
      return renderProse(block, width, theme, context);
    case "reasoning":
      return renderReasoning(block, width, theme);
    case "tool":
    case "subagent-tool":
      return renderTool(block, width, theme, context);
    case "error":
      return renderError(block, width, theme);
    case "notice":
      return renderNotice(block, width, theme);
    case "warning":
      return renderWarning(block, width, theme);
    case "result":
      return renderResult(block, width, theme);
    case "flow":
      return renderFlow(block, width, theme);
    case "command":
      return renderCommand(block, theme, context);
    case "question":
    case "connection-auth":
      return renderPreformatted(block, width, theme);
    case "sandbox":
      return renderSandbox(block, width, theme, context);
    case "log":
      return renderLog(block, width, theme);
    case "task":
      return renderTask(block, width, theme);
    case "turn-stats":
      return renderTurnStats(block, width, theme);
    case "session-boundary":
    case "agent-header":
      // Rows arrive fully styled and width-fit from their builders.
      return (block.body ?? "").split("\n");
  }
}

function renderUser(block: Block, width: number, theme: Theme): string[] {
  const bar =
    block.promptOrigin === "steer" ? theme.colors.yellow(theme.glyph.user) : theme.glyph.user;
  const lines = wrap(block.body ?? "", width - 2);
  return lines.map((line) => `${bar} ${theme.colors.bold(line)}`);
}

function renderProse(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const rows: string[] = [];
  const isSubagent = block.kind === "subagent-step";
  // The brand anchors every top-level response; Markdown styles the content
  // following it, rather than replacing the response gutter.
  const markdown = context.renderMarkdown ?? true;
  const glyph = isSubagent ? "" : `${theme.colors.bold(theme.glyph.brand)} `;
  const indent = isSubagent ? "" : "  ";

  if (block.reasoning && block.reasoning.trim().length > 0) {
    rows.push(...renderReasoningLines(block.reasoning, width, theme));
  }

  const body = (block.body ?? "").trim();
  if (body.length === 0 && rows.length === 0) {
    return [`${glyph}${theme.colors.dim(`thinking${theme.glyph.ellipsis}`)}`];
  }

  if (body.length > 0) {
    const rendered = (markdown ? renderMarkdown(body, width - indent.length) : body)
      .split("\n")
      .flatMap((line) => wrapVisibleLine(line, width - indent.length));
    rendered.forEach((line, index) => {
      if (index === 0 && !isSubagent && rows.length === 0) {
        rows.push(`${glyph}${line}`);
      } else {
        rows.push(`${indent}${line}`);
      }
    });
  }

  return rows.length > 0 ? rows : [`${glyph}`];
}

function renderReasoning(block: Block, width: number, theme: Theme): string[] {
  if (block.collapsed) {
    // A persisted thought labels itself (`Thought for 12s`); a still-live
    // collapse keeps the generic marker.
    return [
      `${theme.colors.gray(theme.glyph.reasoning)} ${theme.colors.dim(block.title ?? "thinking")}`,
    ];
  }
  return renderReasoningLines(block.body ?? "", width, theme, theme.glyph.reasoning);
}

function renderReasoningLines(text: string, width: number, theme: Theme, glyph?: string): string[] {
  const pad = glyph ? 2 : 0;
  const lines = wrap(text.trim(), width - pad);
  if (lines.length === 0) return [];
  return lines.map((line, index) => {
    const prefix = glyph ? (index === 0 ? `${theme.colors.gray(glyph)} ` : "  ") : "";
    return `${prefix}${theme.colors.dim(theme.colors.italic(line))}`;
  });
}

/**
 * Diagnostic dumps below an error headline are capped to this many physical
 * lines — enough for the error class plus the top of the stack, without a
 * deep cause chain flooding the transcript.
 */
const ERROR_DETAIL_MAX_LINES = 12;

function renderError(block: Block, width: number, theme: Theme): string[] {
  const icon = theme.colors.red(theme.colors.bold(theme.glyph.error));
  const title = block.title ?? "Error";
  const rows = [`${icon} ${theme.colors.red(theme.colors.bold(title))}`];
  for (const line of wrap(block.body ?? "", width - 2)) {
    rows.push(`  ${colorizeError(line, theme)}`);
  }
  if (block.hint !== undefined && block.hint.trim().length > 0) {
    // Remediation renders distinct from the failure description: calm
    // color, arrow lead-in, so "what to do" is scannable under "what broke".
    for (const [index, line] of wrap(block.hint, width - 4).entries()) {
      const lead = index === 0 ? `${theme.glyph.arrow} ` : "  ";
      rows.push(`  ${theme.colors.cyan(`${lead}${line}`)}`);
    }
  }
  rows.push(...renderErrorDetail(block.detail, width, theme));
  return rows;
}

/**
 * Renders an error's diagnostic dump (stack trace / cause chain) dim beneath
 * the headline. Lines are clipped, not wrapped: stack frames are long and
 * repetitive, and a hard clip keeps one frame per row so the trace stays
 * scannable.
 */
function renderErrorDetail(detail: string | undefined, width: number, theme: Theme): string[] {
  if (detail === undefined || detail.trim().length === 0) return [];
  const lines = detail.split("\n");
  const visible = lines.slice(0, ERROR_DETAIL_MAX_LINES);
  const rows = visible.map(
    (line) => `  ${theme.colors.dim(truncatePlain(line, Math.max(1, width - 2)))}`,
  );
  const hidden = lines.length - visible.length;
  if (hidden > 0) {
    rows.push(
      `  ${theme.colors.dim(`${theme.glyph.ellipsis} +${hidden} more line${hidden === 1 ? "" : "s"}`)}`,
    );
  }
  return rows;
}

const URL_PATTERN = /(https?:\/\/\S+)/u;

/** Renders an error line in red, but draws any URLs in the cyan link color. */
function colorizeError(line: string, theme: Theme): string {
  if (!URL_PATTERN.test(line)) return theme.colors.red(line);
  return line
    .split(URL_PATTERN)
    .map((segment, index) =>
      index % 2 === 1 ? theme.colors.cyan(segment) : theme.colors.red(segment),
    )
    .join("");
}

function renderNotice(block: Block, width: number, theme: Theme): string[] {
  const marker = theme.colors.dim(theme.glyph.dot);
  const lines = wrap(block.body ?? "", width - 2);
  if (lines.length === 0) return [marker];
  return lines.map((line) => `${marker} ${theme.colors.dim(line)}`);
}

/**
 * The setup attention line (`⚠ 1 setup issue: … · /model`): yellow glyph, body
 * at full intensity, slash commands painted blue so the fix reads as actionable
 * — clearly a system surface, not chat content. Exported so the live footer can
 * render the same line as a clearable element (it disappears once the issue is
 * resolved), not just committed scrollback.
 */
export function renderAttentionRows(body: string, width: number, theme: Theme): string[] {
  const marker = theme.colors.yellow(theme.glyph.warning);
  const lines = wrap(body, width - 2);
  return lines.map((line, index) => `${index === 0 ? marker : " "} ${paintCommands(line, theme)}`);
}

function renderWarning(block: Block, width: number, theme: Theme): string[] {
  return renderAttentionRows(block.body ?? "", width, theme);
}

function paintCommands(line: string, theme: Theme): string {
  return line.replace(/\/[a-z:-]+/g, (token) =>
    isPromptControlCommand(token) ? theme.colors.blue(token) : token,
  );
}

/**
 * A slash command invocation. While it runs, its gutter pulses — or holds a
 * still `▪` beside an open setup panel, which pulses itself. It then carries
 * a settled `*`. A settled summary replaces the invocation, dimmed as a
 * record. The `❯` glyph remains exclusive to live input because the TUI tests
 * use `❯` to detect a ready prompt.
 */
function renderCommand(block: Block, theme: Theme, context: RenderBlockContext): string[] {
  const c = theme.colors;
  const gutter =
    block.live !== true
      ? block.status === "done"
        ? c.gray("*")
        : theme.glyph.user
      : context.transientPanelOpen === true
        ? theme.glyph.user
        : context.setupFlowOpen === true
          ? c.gray(theme.glyph.square)
          : c.gray(context.activityPulse);
  return [`${gutter} ${block.result === undefined ? (block.body ?? "") : c.dim(block.result)}`];
}

/** One persistent setup-flow line retained after a panel closes. */
function renderFlow(block: Block, width: number, theme: Theme): string[] {
  const lines = wrap(block.body ?? "", width - 2);
  const marker = theme.colors.dim("*");
  return lines.map((line, index) => `${index === 0 ? marker : " "} ${line}`);
}

/**
 * One command's outcome, hung under its invocation with the elbow connector
 * (`   ⎿  Login interrupted` in Claude Code's grammar), indented so the body
 * nests under the echoed command's text rather than its `│` marker.
 */
function renderResult(block: Block, width: number, theme: Theme): string[] {
  const lines = wrap(block.body ?? "", width - 7);
  const marker = theme.colors.dim(theme.glyph.elbow);
  if (lines.length === 0) return [`   ${marker}`];
  // SGR 22 closes bold and dim together, so a result that bolds a span (the
  // /model reply's model name) would drop the rest of the line out of dim;
  // re-open dim after each close so the whole line stays quiet.
  const dim = (line: string): string =>
    theme.colors.dim(line.replaceAll("\x1b[22m", "\x1b[22m\x1b[2m"));
  return lines.map((line, index) =>
    index === 0 ? `   ${marker}  ${dim(line)}` : `      ${dim(line)}`,
  );
}

function renderPreformatted(block: Block, width: number, theme: Theme): string[] {
  const glyph =
    block.kind === "connection-auth"
      ? theme.colors.yellow(theme.glyph.connection)
      : theme.colors.yellow(theme.colors.bold(theme.glyph.question));
  // A question's `⎿` answer row hangs one cell past the prompt text so the
  // elbow reads as nested under it.
  const bodyIndent = block.kind === "question" ? "   " : "  ";
  // The title is agent-authored prose (a question prompt, a connection name)
  // and can exceed the width; an overflowing row soft-wraps in the terminal
  // and breaks the live region's one-row-one-line accounting, leaking a
  // duplicate of the row into scrollback on every repaint.
  const title = wrap(block.title ?? "", width - 2);
  const rows =
    title.length === 0
      ? [`${glyph} `]
      : title.map((line, index) =>
          index === 0 ? `${glyph} ${theme.colors.bold(line)}` : `  ${theme.colors.bold(line)}`,
        );
  for (const raw of (block.body ?? "").split("\n")) {
    for (const line of wrapVisibleLine(raw, Math.max(1, width - bodyIndent.length))) {
      rows.push(`${bodyIndent}${line}`);
    }
  }
  return rows;
}

function renderSandbox(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const rule = theme.colors.cyan(theme.glyph.rule);
  const label = theme.colors.dim(`sandbox ${theme.glyph.dot} `);
  const labelWidth = visibleLength(label);
  const labelIndent = " ".repeat(labelWidth);
  const continuesRun = context.previous?.kind === "sandbox";
  const logical = (block.body ?? "").split("\n");

  const rows: string[] = [];
  for (const raw of logical) {
    const wrapped = wrapVisibleLine(raw, Math.max(1, width - 2 - labelWidth));
    for (const line of wrapped) {
      const prefix = rows.length === 0 && !continuesRun ? label : labelIndent;
      rows.push(`${rule} ${prefix}${theme.colors.gray(line)}`);
    }
  }
  return rows.length > 0 ? rows : [`${rule}`];
}

/**
 * Renders captured server output: a `○ stderr` (or `○ stdout`) header with
 * body lines — wrapped continuations included — behind a `│` rail. The rail
 * stays open (no closing corner): a process stream is continuous, and the
 * next write may extend it. A lone write shows its full body; a coalesced
 * run (contiguous writes merged by the display grouping) arrives
 * pre-windowed to its newest lines with the older count on `elided`,
 * rendered as an `… (N more)` row under the header. Whether a source
 * renders at all is the renderer's `LogDisplayMode` filter — this function
 * only ever sees visible blocks.
 */
function renderLog(block: DisplayBlock, width: number, theme: Theme): string[] {
  const isErr = block.title === "stderr";
  const color = isErr ? theme.colors.red : theme.colors.gray;
  const rule = theme.colors.dim(theme.glyph.rule);
  const source = isErr ? "stderr" : "stdout";

  const rows = [`${theme.colors.dim(theme.glyph.reasoning)} ${theme.colors.dim(source)}`];
  if (block.elided !== undefined && block.elided > 0) {
    rows.push(`${rule} ${elisionText(block.elided, theme)}`);
  }
  for (const raw of (block.body ?? "").split("\n")) {
    for (const line of wrapVisibleLine(raw, Math.max(1, width - 2))) {
      rows.push(`${rule} ${theme.colors.dim(color(line))}`);
    }
  }
  return rows;
}

/**
 * The end-of-turn coda: `Done in 3min 24s (↑ 32.4K ↓ 682)`, dim and
 * standalone beneath the assistant's final prose. The body arrives fully
 * composed from the renderer's shared stats builder.
 */
function renderTurnStats(block: Block, width: number, theme: Theme): string[] {
  const line = block.body ?? "";
  return [theme.colors.dim(truncatePlain(line, Math.max(1, width)))];
}

/**
 * A task's line: `※ researcher  Find Q3 revenue numbers` as it starts, and
 * `✓ researcher  finished in 1m 12s · Read 10 files` (or failed, or stopped)
 * as it ends. Each is written once; what the task does in between lives in
 * the task panel above the prompt.
 */
function renderTask(block: Block, width: number, theme: Theme): string[] {
  const c = theme.colors;
  const { mark, detail, color } = taskLineStyle(block, theme);
  const head = `${TOOL_COLUMN_LEAD}${mark} ${c.bold(truncate(block.title ?? "task", width - 4))}`;
  const budget = width - visibleLength(head) - 2;
  if (detail.length === 0 || budget < 6) return [clipVisible(head, Math.max(1, width))];
  return [clipVisible(`${head}  ${color(truncate(detail, budget))}`, Math.max(1, width))];
}

function taskLineStyle(
  block: Block,
  theme: Theme,
): { mark: string; detail: string; color: (text: string) => string } {
  const c = theme.colors;
  switch (block.status) {
    case "done":
      return { mark: c.green(theme.glyph.success), detail: block.body ?? "", color: c.dim };
    case "error":
      return { mark: c.red(theme.glyph.error), detail: block.body ?? "failed", color: c.red };
    case "denied":
      return { mark: c.dim(theme.glyph.square), detail: block.body ?? "stopped", color: c.dim };
    default: {
      const accent = block.taskKind === "agent" ? c.orange : c.gray;
      return { mark: accent(theme.glyph.subagent), detail: block.subtitle ?? "", color: c.gray };
    }
  }
}

function wrap(text: string, width: number): string[] {
  if (text.trim().length === 0) return [];
  return text.split("\n").flatMap((line) => wrapVisibleLine(line, Math.max(1, width)));
}

function truncatePlain(text: string, maxWidth: number): string {
  if (visibleLength(text) <= maxWidth) return text;
  return sliceVisible(text, maxWidth);
}
