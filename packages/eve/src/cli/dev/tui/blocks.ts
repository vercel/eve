import { renderMarkdown, renderHyperlink } from "./markdown.js";
import type { ToolDetailLine } from "./line-diff.js";
import type { TaskKind } from "./task-activity.js";
import type { Theme } from "./theme.js";
import type { ToolGroupPresentation } from "./tool-presentation.js";
import { isPromptControlCommand } from "./prompt-commands.js";
import { renderTool, renderToolHeader } from "./tool-rows.js";
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

export interface Block {
  kind: BlockKind;
  id?: string;
  depth?: number;
  live?: boolean;

  title?: string;
  doneTitle?: string;
  subtitle?: string;
  body?: string;
  promptOrigin?: "steer" | "queue";
  reasoning?: string;
  result?: string;
  detail?: string;
  hint?: string;

  status?: ToolStatus;
  link?: string;
  preformatted?: boolean;
  collapsed?: boolean;
  expanded?: boolean;
  logVisibility?: "summary" | "all-only";
  logLevel?: "error" | "warn" | "info" | "debug";
  toolInput?: unknown;
  toolOutput?: unknown;
  toolName?: string;
  toolGroup?: ToolGroupPresentation;
  detailLines?: readonly ToolDetailLine[];
  keepDetailWhenDone?: boolean;
  subagentCallId?: string;
  parentCallId?: string;
  agentName?: string;
  taskKind?: TaskKind;
  updateSeq?: number;
}

export interface DisplayBlock extends Block {
  toolGroupItems?: readonly ToolGroupItem[];
  elided?: number;
}

export interface ToolGroupItem {
  readonly text: string;
  readonly result?: string;
}

export interface RenderBlockContext {
  activityPulse: string;
  setupFlowOpen?: boolean;
  transientPanelOpen?: boolean;
  renderMarkdown?: boolean;
  previous?: { kind: BlockKind; title?: string; subagentCallId?: string };
}

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

const ERROR_DETAIL_MAX_LINES = 12;

function renderError(block: Block, width: number, theme: Theme): string[] {
  const icon = theme.colors.red(theme.colors.bold(theme.glyph.error));
  const title = block.title ?? "Error";
  const rows = [`${icon} ${theme.colors.red(theme.colors.bold(title))}`];
  for (const line of wrap(block.body ?? "", width - 2)) {
    rows.push(`  ${colorizeError(line, theme)}`);
  }
  if (block.hint !== undefined && block.hint.trim().length > 0) {
    for (const [index, line] of wrap(block.hint, width - 4).entries()) {
      const lead = index === 0 ? `${theme.glyph.arrow} ` : "  ";
      rows.push(`  ${theme.colors.cyan(`${lead}${line}`)}`);
    }
  }
  rows.push(...renderErrorDetail(block.detail, width, theme));
  return rows;
}

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

function renderFlow(block: Block, width: number, theme: Theme): string[] {
  const lines = wrap(block.body ?? "", width - 2);
  const marker = theme.colors.dim("*");
  return lines.map((line, index) => `${index === 0 ? marker : " "} ${line}`);
}

function renderResult(block: Block, width: number, theme: Theme): string[] {
  const lines = wrap(block.body ?? "", width - 7);
  const marker = theme.colors.dim(theme.glyph.elbow);
  if (lines.length === 0) return [`   ${marker}`];
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
  const bodyIndent = block.kind === "question" ? "   " : "  ";
  const title = wrap(block.title ?? "", width - 2);
  const rows =
    title.length === 0
      ? [`${glyph} `]
      : title.map((line, index) =>
          index === 0 ? `${glyph} ${theme.colors.bold(line)}` : `  ${theme.colors.bold(line)}`,
        );
  for (const raw of (block.body ?? "").split("\n")) {
    const isLink = block.link !== undefined && raw === block.link;
    for (const line of wrapVisibleLine(raw, Math.max(1, width - bodyIndent.length))) {
      rows.push(`${bodyIndent}${isLink ? renderHyperlink(line, raw) : line}`);
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

function renderLog(block: DisplayBlock, width: number, theme: Theme): string[] {
  const color =
    block.logLevel === "error"
      ? theme.colors.red
      : block.logLevel === "warn"
        ? theme.colors.yellow
        : theme.colors.gray;
  const rule = theme.colors.dim(theme.glyph.rule);
  const source = block.logLevel ?? block.title ?? "stdout";

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

function renderTurnStats(block: Block, width: number, theme: Theme): string[] {
  const line = block.body ?? "";
  return [theme.colors.dim(truncatePlain(line, Math.max(1, width)))];
}

function renderTask(block: DisplayBlock, width: number, theme: Theme): string[] {
  if (block.status === undefined) {
    return [
      ` ${renderToolHeader(block.title ?? "task", block.subtitle ?? "", theme.colors.gray(theme.glyph.square), width - 1, theme)}`,
    ];
  }
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
