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
import { sliceVisible, visibleLength, wrapVisibleLine } from "#cli/ui/terminal-text.js";

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
  | "connection-auth"
  | "sandbox"
  | "log"
  | "turn-stats"
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
  /** Display-only items populated when equivalent tool blocks are coalesced. */
  toolGroupItems?: readonly ToolGroupItem[];
  /** Salient body lines rendered behind the `│` rail under the tool header. */
  detailLines?: readonly ToolDetailLine[];
  /** When true, `detailLines` stay visible after the call settles (writes). */
  keepDetailWhenDone?: boolean;
  /** Links a subagent section's header and children so calls can coalesce. */
  subagentCallId?: string;
  /**
   * Display-only stand-in for this many earlier sibling rows elided from a
   * capped subagent run; renders as a single dim `… +N more` line.
   */
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
  /**
   * Kind and title of the block rendered immediately above this one. Lets a
   * log block detect that it continues a same-source run (label suppressed,
   * lines hang under the previous block's label) without any mutable run
   * state — each captured write stays its own immediately-committed block.
   */
  previous?: { kind: BlockKind; title?: string };
}

/**
 * Renders a block to its terminal rows. Each row is fully styled and clipped
 * to `width` visible columns.
 */
export function renderBlockLines(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const depth = block.depth ?? 0;
  const prefix = nestingPrefix(depth, theme);
  const avail = Math.max(8, width - visibleLength(prefix));
  const rows = renderBody(block, avail, theme, context);
  return rows.map((row) => `${prefix}${row}`);
}

/**
 * The gutter prefix repeated for each nesting level: a Vercel-orange vertical
 * rule that visually contains a subagent's output beneath its header.
 */
function nestingPrefix(depth: number, theme: Theme): string {
  if (depth <= 0) return "";
  const rule = `${theme.colors.orange(theme.glyph.rule)} `;
  return rule.repeat(depth);
}

function renderBody(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  if (block.elided !== undefined) {
    return [theme.colors.dim(`${theme.glyph.ellipsis} +${block.elided} more`)];
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
      return renderLog(block, width, theme, context);
    case "subagent":
      return renderSubagentHeader(block, width, theme);
    case "turn-stats":
      return renderTurnStats(block, width, theme);
    case "agent-header":
      // Rows arrive fully styled and width-fit from `buildAgentHeader`.
      return (block.body ?? "").split("\n");
  }
}

function renderUser(block: Block, width: number, theme: Theme): string[] {
  const bar = theme.colors.cyan(theme.glyph.user);
  const lines = wrap(block.body ?? "", width - 2);
  return lines.map((line) => `${bar} ${line}`);
}

function renderProse(block: Block, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  const isSubagent = block.kind === "subagent-step";
  const glyph = isSubagent ? "" : `${theme.colors.bold(theme.colors.white(theme.glyph.brand))} `;
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
    return [`${theme.colors.gray(theme.glyph.reasoning)} ${theme.colors.dim("thinking")}`];
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
 * nests under the echoed command's text rather than its `▌` marker.
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
  // Questions share the tool grammar's one-cell indent so `?` sits in the
  // same column as `▪`.
  const lead = block.kind === "question" ? " " : "";
  // The title is agent-authored prose (a question prompt, a connection name)
  // and can exceed the width; an overflowing row soft-wraps in the terminal
  // and breaks the live region's one-row-one-line accounting, leaking a
  // duplicate of the row into scrollback on every repaint.
  const title = wrap(block.title ?? "", width - 2 - lead.length);
  const rows =
    title.length === 0
      ? [`${lead}${glyph} `]
      : title.map((line, index) =>
          index === 0
            ? `${lead}${glyph} ${theme.colors.bold(line)}`
            : `${lead}  ${theme.colors.bold(line)}`,
        );
  for (const raw of (block.body ?? "").split("\n")) {
    for (const line of wrapVisibleLine(raw, width - 2 - lead.length)) {
      rows.push(`${lead}  ${line}`);
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
 * Renders one captured server-output write. The source label (`stdout ·` /
 * `stderr ·`) appears on the first row; every following line — wrapped
 * continuations included — hangs indented beneath it. When the block
 * directly continues a same-source log block (`context.previous`), the label
 * is suppressed entirely so consecutive writes read as one run, while each
 * write remains its own immediately-committed block (no unbounded live
 * state). A rendered block is never truncated: a transcript can't be clicked
 * open, so the full output is shown, kept legible by the `│` rule and the
 * hanging indent. Whether a source renders at all is the renderer's
 * `LogDisplayMode` filter — this function only ever sees visible blocks.
 */
function renderLog(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const isErr = block.title === "stderr";
  const color = isErr ? theme.colors.red : theme.colors.gray;
  const rule = theme.colors.dim(theme.glyph.rule);
  const source = isErr ? "stderr" : "stdout";
  const label = theme.colors.dim(`${source} ${theme.glyph.dot} `);
  const labelWidth = visibleLength(label);
  const labelIndent = " ".repeat(labelWidth);
  const continuesRun = context.previous?.kind === "log" && context.previous.title === block.title;
  const logical = (block.body ?? "").split("\n");

  const rows: string[] = [];
  for (const raw of logical) {
    const wrapped = wrapVisibleLine(raw, Math.max(1, width - 2 - labelWidth));
    for (const line of wrapped) {
      const prefix = rows.length === 0 && !continuesRun ? label : labelIndent;
      rows.push(`${rule} ${prefix}${theme.colors.dim(color(line))}`);
    }
  }
  return rows.length > 0 ? rows : [`${rule}`];
}

/**
 * The end-of-turn coda: a dim rule fragment carrying the turn's wall-clock
 * duration and token flow, hung under the assistant's final prose at its
 * body indent. A closing mark, not a section divider — it stays short.
 */
function renderTurnStats(block: Block, width: number, theme: Theme): string[] {
  const rule = theme.glyph.dash.repeat(3);
  const line = `${rule} ${block.body ?? ""} ${rule}`;
  return [`  ${theme.colors.dim(truncatePlain(line, Math.max(1, width - 2)))}`];
}

function renderSubagentHeader(block: Block, width: number, theme: Theme): string[] {
  const name = truncatePlain(block.title ?? "subagent", Math.max(8, width - 14));
  let header = `${theme.colors.orange(theme.glyph.subagent)} ${theme.colors.bold(name)} ${theme.colors.dim("subagent")}`;
  if (block.subtitle !== undefined && block.subtitle.length > 0) {
    header += ` ${theme.colors.dim(`${theme.glyph.dot} ${block.subtitle}`)}`;
  }
  return [header];
}

function wrap(text: string, width: number): string[] {
  if (text.trim().length === 0) return [];
  return text.split("\n").flatMap((line) => wrapVisibleLine(line, Math.max(1, width)));
}

function truncatePlain(text: string, maxWidth: number): string {
  if (visibleLength(text) <= maxWidth) return text;
  return sliceVisible(text, maxWidth);
}
