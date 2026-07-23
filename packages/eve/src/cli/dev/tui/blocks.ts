/**
 * The transcript block model and its renderer.
 *
 * A {@link Block} is one logical unit of the conversation — a user message, a
 * streamed assistant reply, a reasoning trace, a tool call, a nested subagent
 * step, a log line, and so on. {@link renderBlockLines} turns a block into the
 * exact terminal rows it occupies: a colored gutter glyph, brand-aligned
 * indentation, nesting rules for subagents, and word-wrapped content — with no
 * boxes anywhere. Every returned row is already styled and fits within the
 * given width, so the live region can place rows verbatim.
 */

import { renderMarkdown } from "./markdown.js";
import type { ToolDetailLine } from "./line-diff.js";
import type { Theme } from "./theme.js";
import type { ToolGroupPresentation } from "./tool-presentation.js";
import { isPromptControlCommand } from "./prompt-commands.js";
import { renderTool } from "./tool-rows.js";
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
  | "subagent"
  | "subagent-step"
  | "subagent-tool"
  | "subagent-close"
  | "connection-auth"
  | "sandbox"
  | "log"
  | "turn-stats"
  | "session-boundary"
  | "todo-list"
  | "agent-header";

/**
 * One renderable transcript unit. Fields are interpreted per `kind`; unset
 * fields are simply omitted from the rendered output.
 */
export interface Block {
  kind: BlockKind;
  /** Stable id for in-place updates while the block is live. */
  id?: string;
  /** Nesting depth: 0 = top level, 1 = inside a subagent, etc. */
  depth?: number;
  /** Whether the block is still streaming / mutating (drives the activity pulse). */
  live?: boolean;

  /** Primary label — tool name, subagent name, log source, error title. */
  title?: string;
  /** Past-tense tool label swapped in once the call settles successfully. */
  doneTitle?: string;
  /** Compact secondary text — summarized tool args. */
  subtitle?: string;
  /** Main multi-line content (markdown for prose, plain for logs). */
  body?: string;
  /**
   * User blocks only: how a mid-turn message reached the transcript. A
   * steered message (Esc pop, displacing the running turn) marks itself
   * with the accent arrow above its bar; a queued one (drained at the turn
   * boundary) carries the arrow below. Absent for ordinary typed prompts.
   */
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

  /** Tool, connection, or synthetic command lifecycle status. */
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
  /** Links a subagent section's header and children so calls can coalesce. */
  subagentCallId?: string;
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
  /**
   * Stand-in for this many earlier sibling rows elided from a capped
   * subagent run; renders as a single dim `… +N more` line.
   */
  elided?: number;
  /**
   * This block is the last of its section, so its final row swaps the
   * nesting rule for the closing `└` — the rail ends on the newest child
   * instead of a bare corner row.
   */
  closesRail?: boolean;
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
  /**
   * Kind and title of the block rendered immediately above this one. Lets a
   * sandbox block detect that it continues a run (label suppressed, lines
   * hang under the previous block's label) without any mutable run state —
   * each captured write stays its own immediately-committed block.
   */
  previous?: { kind: BlockKind; title?: string };
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
  const rows = renderBody(block, avail, theme, context);
  // The section's last row carries the closing corner in place of its rule.
  if (block.closesRail === true && depth > 0) {
    const corner = closingPrefix(depth, theme);
    return rows.map((row, index) => `${index === rows.length - 1 ? corner : prefix}${row}`);
  }
  return rows.map((row) => `${prefix}${row}`);
}

/**
 * The gutter prefix for nested rows: the section's two-cell tool-column
 * indent, then a dim vertical rule per nesting level to contain a
 * subagent's output beneath its header — the `※` mark alone carries the
 * section's orange.
 */
function nestingPrefix(depth: number, theme: Theme): string {
  if (depth <= 0) return "";
  const rule = `${theme.colors.dim(theme.glyph.rule)} `;
  return `${TOOL_COLUMN_LEAD}${rule.repeat(depth)}`;
}

/** The nesting prefix with its innermost rule swapped for the closing `└`. */
function closingPrefix(depth: number, theme: Theme): string {
  const rule = `${theme.colors.dim(theme.glyph.rule)} `;
  return `${TOOL_COLUMN_LEAD}${rule.repeat(depth - 1)}${theme.colors.dim(theme.glyph.corner)} `;
}

function renderBody(
  block: DisplayBlock,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  // The subagent stand-in row, indented one cell so it aligns with the
  // tool marks beside it; other kinds (a coalesced log run) render their
  // elided count inside their own section.
  if (block.elided !== undefined && block.kind === "subagent-step") {
    return [` ${elisionText(block.elided, theme)}`];
  }
  switch (block.kind) {
    case "user":
      return renderUser(block, width, theme);
    case "assistant":
    case "subagent-step":
      return renderProse(block, width, theme);
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
      return renderCommand(block, theme);
    case "question":
    case "connection-auth":
      return renderPreformatted(block, width, theme);
    case "sandbox":
      return renderSandbox(block, width, theme, context);
    case "log":
      return renderLog(block, width, theme);
    case "subagent":
      return renderSubagentHeader(block, width, theme, context);
    case "subagent-close": {
      // Closes the section's rail. A completed section's corner carries
      // the collapsed activity footnote instead of railed children.
      const corner = `${TOOL_COLUMN_LEAD}${theme.colors.dim(theme.glyph.corner)}`;
      if (block.body !== undefined && block.body.length > 0) {
        return [clipVisible(`${corner} ${theme.colors.dim(block.body)}`, Math.max(1, width))];
      }
      return [corner];
    }
    case "turn-stats":
      return renderTurnStats(block, width, theme);
    case "session-boundary":
    case "todo-list":
    case "agent-header":
      // Rows arrive fully styled and width-fit from their builders.
      return (block.body ?? "").split("\n");
  }
}

function renderUser(block: Block, width: number, theme: Theme): string[] {
  const bar = theme.colors.cyan(theme.glyph.user);
  const lines = wrap(block.body ?? "", width - 2);
  const rows = lines.map((line) => `${bar} ${line}`);
  // Mid-turn provenance rides the gutter in the bar's own accent: a steered
  // message pushed itself ahead of the running turn (arrow above), a queued
  // one waited for the boundary (arrow below).
  const arrow = theme.colors.cyan(theme.glyph.arrowUp);
  if (block.promptOrigin === "steer") return [arrow, ...rows];
  if (block.promptOrigin === "queue") return [...rows, arrow];
  return rows;
}

function renderProse(block: Block, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  const isSubagent = block.kind === "subagent-step";
  // A collapsed child message is one activity row in its section — the
  // parent's own `▲` reply carries the conclusion. `--subagents full`
  // restores the verbatim prose.
  if (isSubagent && block.collapsed === true) {
    const line =
      firstNonEmptyLine(block.body) ??
      (block.reasoning === undefined ? undefined : firstNonEmptyLine(block.reasoning));
    if (line === undefined) return [];
    return [theme.colors.dim(sliceVisible(line, Math.max(1, width)))];
  }
  // Bold at the terminal's DEFAULT foreground: black on a light theme,
  // white on a dark one. Explicit bright-white (SGR 97) would vanish on
  // light backgrounds.
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
    const rendered = renderMarkdown(body, width - indent.length)
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
 * A slash command invocation under the user gutter. Automatic commands use
 * the same row so their result can follow it. The `❯`/`›` glyphs remain
 * exclusive to live input because the TUI tests use `›` (the empty prompt's
 * quiet mark) to detect a ready prompt.
 */
function renderCommand(block: Block, theme: Theme): string[] {
  const c = theme.colors;
  const status = block.status === "error" ? `${c.red(theme.glyph.error)} ` : "";
  return [`${c.cyan(theme.glyph.user)} ${status}${c.blue(block.body ?? "")}`];
}

/**
 * One persistent setup-flow line: progress the user must keep (the Slack
 * Connect URL, a written env file). The tone travels in `title`; info dims,
 * the other tones keep the body at full intensity behind their glyph.
 */
function renderFlow(block: Block, width: number, theme: Theme): string[] {
  const c = theme.colors;
  const tone = block.title ?? "info";
  const glyph =
    tone === "success"
      ? c.green(theme.glyph.success)
      : tone === "warning"
        ? c.yellow(theme.glyph.warning)
        : tone === "error"
          ? c.red(theme.glyph.error)
          : c.dim(theme.glyph.dot);
  const lines = wrap(block.body ?? "", width - 2);
  const paint = (line: string): string => (tone === "info" ? c.dim(line) : line);
  return lines.map((line, index) => `${index === 0 ? glyph : " "} ${paint(line)}`);
}

/**
 * One command's outcome, hung under its invocation with the elbow connector
 * (`   ⎿  Login interrupted` in Claude Code's grammar), indented so the body
 * nests under the echoed command's text rather than its `│` marker.
 */
function renderResult(block: Block, width: number, theme: Theme): string[] {
  const marker = theme.colors.dim(theme.glyph.elbow);
  const lines = wrap(block.body ?? "", width - 7);
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
 * The end-of-turn coda: `└ Done in 3min 24s ── ↑ 32.4K ↓ 682`, dim,
 * closing the turn under the assistant's final prose. The corner is the
 * settled form of the live `▪ Working… <duration> ── <flow>` turn bar; the
 * body arrives fully composed from the renderer's shared stats builder.
 */
function renderTurnStats(block: Block, width: number, theme: Theme): string[] {
  const line = `${theme.glyph.corner} ${block.body ?? ""}`;
  return [theme.colors.dim(truncatePlain(line, Math.max(1, width)))];
}

function renderSubagentHeader(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  // `subagent(<name>)`; the generic self-delegation tool (literally named
  // `agent`) reads as `subagent(self)`. Only the `※` mark carries orange —
  // lead, rails, and name stay quiet around it.
  const isSelf = block.title === undefined || block.title === "agent";
  const rawName = isSelf ? "self" : block.title!;
  const name = truncatePlain(rawName, Math.max(8, width - 16));
  const lead = TOOL_COLUMN_LEAD;
  // The ordinal rides inside the parens (`subagent(self:4)`) in every
  // state. Completion reports on the closing corner (`└ Done…`); the
  // header only settles its mark: an in-progress section pulses the `※`
  // on the shared activity beat — by intensity (orange ↔ dim), so the
  // glyph keeps anchoring the section — and a done one holds green.
  const isOrdinal = block.subtitle !== undefined && block.subtitle.startsWith("#");
  const ordinal = isOrdinal ? `:${block.subtitle!.slice(1)}` : "";
  const mark =
    block.status === "done"
      ? theme.colors.green(theme.glyph.subagent)
      : context.activityPulse.trim().length > 0
        ? theme.colors.orange(theme.glyph.subagent)
        : theme.colors.dim(theme.glyph.subagent);
  let header = `${lead}${mark} subagent(${name}${ordinal})`;
  if (!isOrdinal && block.subtitle !== undefined && block.subtitle.length > 0) {
    header += ` ${theme.colors.dim(block.subtitle)}`;
  }
  return [header];
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}

function wrap(text: string, width: number): string[] {
  if (text.trim().length === 0) return [];
  return text.split("\n").flatMap((line) => wrapVisibleLine(line, Math.max(1, width)));
}

function truncatePlain(text: string, maxWidth: number): string {
  if (visibleLength(text) <= maxWidth) return text;
  return sliceVisible(text, maxWidth);
}
