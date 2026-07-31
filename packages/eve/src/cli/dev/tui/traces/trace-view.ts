/**
 * Pure frame renderer for the `/traces` conversation viewer: state in,
 * styled rows out. The layout is a header (trace identity), a body (the
 * conversation cards, plus the optional details drawer on the right), and a
 * footer (key hints + position/notice). Every row is clipped to the
 * terminal width so the alt-screen painter can write rows verbatim.
 */

import { formatElapsed } from "#cli/format-elapsed.js";
import {
  clipVisible,
  sliceVisible,
  stripAnsi,
  stripTerminalControls,
  visibleLength,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";
import type { LocalTraceSpan } from "#harness/local-trace-reader.js";
import { describeLocalTraceSpan } from "#harness/local-trace-reader.js";

import type { Theme } from "../theme.js";
import { formatAttributeContent } from "./trace-content.js";
import { renderConversationItem } from "./trace-conversation.js";
import type { TextSelectionRange, TraceViewerState } from "./trace-viewer-state.js";
import { orderedTextSelection, selectedTraceViewerSpan } from "./trace-viewer-state.js";

const HEADER_ROWS = 1;
const FOOTER_ROWS = 2;
/** The body always keeps at least this many columns. */
const BODY_MIN_WIDTH = 20;
const PANEL_MIN_WIDTH = 20;
const PANEL_MAX_WIDTH = 64;

export interface TraceViewerFrame {
  readonly rows: readonly string[];
  /** Detail rows the panel has for the selected span — fed back into key handling. */
  readonly panelTotalRows: number;
  /** Body rows available to the conversation. */
  readonly timelineViewportRows: number;
  /** Body rows available to the panel. */
  readonly panelViewportRows: number;
  /** Column width the body renders at (expandability is width-dependent). */
  readonly contentWidth: number;
}

export interface RenderTraceViewerOptions {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  /** The viewed trace received spans recently — the window extends to "now". */
  readonly activeWindowEndNs?: bigint;
  /** Tracing is disabled via `EVE_TRACES=off` (empty-state copy). */
  readonly tracingDisabled?: boolean;
  /** Transient confirmation shown in the header's top-right corner. */
  readonly toast?: string;
}

export function renderTraceViewer(
  state: TraceViewerState,
  options: RenderTraceViewerOptions,
): TraceViewerFrame {
  const { width, height, theme } = options;
  const bodyRows = Math.max(1, height - HEADER_ROWS - FOOTER_ROWS);
  const panelWidth = state.panelOpen ? panelWidthFor(width) : 0;
  const timelineWidth = Math.max(20, width - (panelWidth === 0 ? 0 : panelWidth + 1));

  const detailLines = panelDetailLines(state, panelWidth, theme);
  const panelViewportRows = bodyRows;

  const rows: string[] = [];
  rows.push(...renderHeader(state, options));
  if (state.traces.length === 0) {
    rows.push(...padBody(renderEmptyState(options, theme, bodyRows), bodyRows));
  } else if (state.trace === undefined) {
    rows.push(...padBody(center(bodyRows, theme.colors.dim("Loading trace…")), bodyRows));
  } else {
    const body = renderConversation(state, options, timelineWidth, bodyRows);
    for (let index = 0; index < bodyRows; index += 1) {
      const left = body[index] ?? "";
      if (panelWidth === 0) {
        rows.push(left);
        continue;
      }
      // No divider: the base canvas separates the cards and drawer by itself.
      const separator = " ";
      let panelLine = detailLines[state.panelScroll + index] ?? "";
      if (state.textSelection !== undefined && state.textSelection.region === "panel") {
        panelLine = highlightSelection(
          panelLine,
          state.panelScroll + index,
          state.textSelection,
          panelWidth,
        );
      }
      rows.push(joinPanels(left, timelineWidth, separator, panelLine, width));
    }
  }
  rows.push(...renderFooter(state, width, theme));

  return {
    rows: rows.map((row) => withViewerBase(row, width, theme)),
    panelTotalRows: detailLines.length,
    timelineViewportRows: bodyRows,
    panelViewportRows,
    contentWidth: timelineWidth,
  };
}

/**
 * The viewer's canvas: Catppuccin Macchiato `base` behind every row, so the
 * whole screen reads as one surface and the `surface1` cards elevate above
 * it. Rows are padded to full width; embedded style resets AND bg-closes are
 * followed by a base re-open so neither a truncated line nor a card's
 * trailing bg-close can drop the canvas (card bg-closes once let the
 * terminal's default background bleed through the drawer). Truecolor is
 * exempt from tinted-theme palette remapping.
 */
const VIEWER_BASE_OPEN = "\x1b[48;2;0;0;0m";
const VIEWER_BASE_REOPEN = `\x1b[0m${VIEWER_BASE_OPEN}`;
const VIEWER_BASE_REOPEN_BG = `\x1b[49m${VIEWER_BASE_OPEN}`;
const RESET_ALL = "\x1b[0m";

function withViewerBase(row: string, width: number, theme: Theme): string {
  if (!theme.color) return row;
  const padded = visibleLength(row) >= width ? row : row + " ".repeat(width - visibleLength(row));
  return `${VIEWER_BASE_OPEN}${padded
    .replaceAll("\x1b[0m", VIEWER_BASE_REOPEN)
    .replaceAll("\x1b[49m", VIEWER_BASE_REOPEN_BG)}${RESET_ALL}`;
}

/** Renders the attributes panel body for one span (name, facts, attributes). */
/**
 * Payload attributes the conversation cards already show; the drawer skips
 * them in conversation mode so it stays metadata-focused.
 */
const CONVERSATION_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "ai.prompt.messages",
  "ai.prompt.system",
  "ai.response.reasoning",
  "ai.response.text",
  "ai.response.tool_calls",
  "ai.response.tool_results",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

export function renderSpanDetail(
  span: LocalTraceSpan,
  innerWidth: number,
  theme: Theme,
  options?: { readonly excludeKeys?: ReadonlySet<string> },
): string[] {
  const { colors } = theme;
  const lines: string[] = [];
  const name = stripTerminalControls(span.name);
  lines.push(...wrapVisibleLine(colors.bold(name), innerWidth));
  const summary = describeLocalTraceSpan(span).map(stripTerminalControls);
  if (summary.length > 0) lines.push(colors.dim(summary.join(", ")));
  lines.push("");

  const fact = (label: string, value: string): string => `${colors.dim(label.padEnd(10))}${value}`;
  const error = span.statusCode === 2;
  lines.push(fact("status", error ? colors.red("ERROR") : colors.green("ok")));
  lines.push(fact("duration", formatElapsed(durationMs(span.startTimeNs, span.endTimeNs))));
  lines.push(fact("started", clockTime(span.startTimeNs)));
  lines.push(fact("span", span.spanId));
  if (span.parentSpanId !== undefined) lines.push(fact("parent", span.parentSpanId));
  if (span.scope !== undefined) lines.push(fact("scope", stripTerminalControls(span.scope)));
  lines.push("");

  const keys = Object.keys(span.attributes)
    .filter((key) => options?.excludeKeys?.has(key) !== true)
    .sort();
  if (keys.length === 0) {
    lines.push(colors.dim("no attributes"));
  } else {
    lines.push(colors.dim(`attributes (${keys.length})`));
    for (const key of keys) {
      const block = formatAttributeContent(key, span.attributes[key], theme, innerWidth - 2);
      const cleanKey = stripTerminalControls(key);
      if (block.length === 1) {
        // Scalars stay beside the key; multi-line content nests beneath it.
        lines.push(...wrapVisibleLine(`${colors.dim(cleanKey)} ${block[0]}`, innerWidth));
      } else {
        lines.push(colors.dim(cleanKey));
        for (const line of block) {
          lines.push(`  ${line}`);
        }
      }
    }
  }
  return lines.map((line) => clipVisible(line, innerWidth));
}

function renderHeader(state: TraceViewerState, options: RenderTraceViewerOptions): string[] {
  const { theme, width } = options;
  const { colors, glyph } = theme;
  const segments: string[] = [];
  if (state.trace?.agentName !== undefined) {
    segments.push(stripTerminalControls(state.trace.agentName));
  }
  if (state.trace?.sessionId !== undefined) {
    segments.push(`session ${stripTerminalControls(state.trace.sessionId)}`);
  }
  if (state.trace !== undefined) {
    const end =
      options.activeWindowEndNs !== undefined && options.activeWindowEndNs > state.trace.endTimeNs
        ? options.activeWindowEndNs
        : state.trace.endTimeNs;
    segments.push(
      clockTime(state.trace.startTimeNs),
      `${state.trace.spans.length} span${state.trace.spans.length === 1 ? "" : "s"}`,
      formatElapsed(durationMs(state.trace.startTimeNs, end)),
    );
  }
  const title = `${colors.bold(`${glyph.brand} traces`)}${
    segments.length === 0 ? "" : colors.dim(` · ${segments.join(" · ")}`)
  }`;
  const position =
    state.traces.length === 0 ? "" : colors.dim(`[${state.traceIndex + 1}/${state.traces.length}]`);
  const live = options.activeWindowEndNs !== undefined ? colors.green("● live") : "";
  const toast =
    options.toast === undefined
      ? ""
      : colors.green(`${theme.unicode ? "✓ " : ""}${stripTerminalControls(options.toast)}`);
  const right = [toast, live, position].filter((part) => part.length > 0).join(" ");
  // The badge keeps its room: the title (full session id and all) clips first.
  const header = joinRight(
    clipVisible(title, Math.max(0, width - visibleLength(right) - 1)),
    right,
    width,
  );
  return [clipVisible(header, width)];
}

/** The conversation flow: user/assistant/tool cards in turn order. */
function renderConversation(
  state: TraceViewerState,
  options: RenderTraceViewerOptions,
  width: number,
  bodyRows: number,
): string[] {
  const { theme } = options;
  if (state.conversationItems.length === 0) {
    return [
      theme.colors.dim(
        "  No conversation content in this trace — content capture may be off (EVE_TRACES_CONTENT).",
      ),
    ];
  }
  // Render all cards, then apply the line-level scroll offset so expanded
  // cards taller than the viewport can be scrolled through to the end.
  const allLines = conversationLines(state, width, theme);
  const visible = allLines.slice(state.scrollRow, state.scrollRow + bodyRows);
  if (state.textSelection === undefined || state.textSelection.region !== "conversation") {
    return visible;
  }
  return visible.map((line, index) =>
    highlightSelection(line, state.scrollRow + index, state.textSelection!, width),
  );
}

function conversationLines(state: TraceViewerState, width: number, theme: Theme): string[] {
  const allLines: string[] = [];
  for (let index = 0; index < state.conversationItems.length; index += 1) {
    allLines.push(
      ...renderConversationItem(
        state.conversationItems[index]!,
        width,
        theme,
        index === state.selectedRow,
        state.expandedItems.has(index),
      ),
      "",
    );
  }
  return allLines;
}

/**
 * The drawer's display lines for the selected span: one row of top padding
 * and one column of side padding around the span detail. A panel that
 * doesn't fit (very narrow terminal) isn't modeled as open — otherwise key
 * handling would scroll content nobody can see.
 */
function panelDetailLines(state: TraceViewerState, panelWidth: number, theme: Theme): string[] {
  const selected = selectedTraceViewerSpan(state);
  if (!state.panelOpen || panelWidth <= 0 || selected === undefined) return [];
  return [
    "",
    ...renderSpanDetail(selected, Math.max(16, panelWidth - 3), theme, {
      excludeKeys: CONVERSATION_CONTENT_KEYS,
    }).map((line) => ` ${line}`),
  ];
}

/**
 * Plain text covered by a drag selection over the conversation, extracted
 * from the same rendered lines the user saw.
 */
export function conversationSelectionText(
  state: TraceViewerState,
  width: number,
  theme: Theme,
  selection: TextSelectionRange,
): string {
  return selectionText(conversationLines(state, width, theme), selection);
}

/**
 * Plain text covered by a drag selection over the details drawer, extracted
 * from the same detail lines the frame painted. `totalWidth` is the full
 * terminal width — the drawer's width derives from it exactly as rendering
 * does, so columns map to the same cells the user selected.
 */
export function panelSelectionText(
  state: TraceViewerState,
  totalWidth: number,
  theme: Theme,
  selection: TextSelectionRange,
): string {
  const panelWidth = state.panelOpen ? panelWidthFor(totalWidth) : 0;
  return selectionText(panelDetailLines(state, panelWidth, theme), selection);
}

/**
 * Slices the selected cells out of rendered lines: partial first/last lines
 * honor the columns, middle lines contribute in full, and each line loses
 * its trailing padding.
 */
function selectionText(lines: readonly string[], selection: TextSelectionRange): string {
  const { start, end } = orderedTextSelection(selection);
  const parts: string[] = [];
  for (let line = Math.max(0, start.line); line <= end.line && line < lines.length; line += 1) {
    const text = stripAnsi(lines[line]!);
    const from = line === start.line ? start.column : 0;
    const to = line === end.line ? end.column + 1 : Number.POSITIVE_INFINITY;
    const head = to === Number.POSITIVE_INFINITY ? text : sliceVisible(text, to);
    const prefixLength = sliceVisible(text, from).length;
    parts.push(head.slice(prefixLength).trimEnd());
  }
  return parts.join("\n");
}

/** Paints the selected cells of one visible row in reverse video. */
function highlightSelection(
  row: string,
  line: number,
  selection: TextSelectionRange,
  width: number,
): string {
  const { start, end } = orderedTextSelection(selection);
  if (line < start.line || line > end.line) return row;
  const from = line === start.line ? start.column : 0;
  const to = line === end.line ? end.column + 1 : width;
  // Selection can extend past a row's painted cells; pad so the highlight
  // shows the full extent the copy will cover.
  const rowWidth = visibleLength(row);
  const padded = rowWidth < to ? row + " ".repeat(to - rowWidth) : row;
  const prefix = sliceVisible(padded, from);
  const withSelection = sliceVisible(padded, to);
  const middle = withSelection.slice(prefix.length);
  const suffix = padded.slice(withSelection.length);
  if (middle.length === 0) return row;
  // Re-assert reverse video after any embedded reset so a card's internal
  // style changes cannot end the highlight early.
  const inverted = middle.replaceAll("\x1b[0m", "\x1b[0m\x1b[7m");
  return `${prefix}\x1b[7m${inverted}\x1b[27m${suffix}`;
}

function renderFooter(state: TraceViewerState, width: number, theme: Theme): string[] {
  const { colors } = theme;
  const [upDown, leftRight] = theme.unicode ? ["↑↓", "←→"] : ["^/v", "</>"];
  const hints = state.panelFocus
    ? `${upDown} scroll · tab cards · esc back`
    : `${upDown} select · ${leftRight} expand · enter attrs · tab focus · [ ] traces · q close`;
  const itemCount = state.conversationItems.length;
  const position = itemCount === 0 ? "" : colors.dim(`item ${state.selectedRow + 1}/${itemCount}`);
  const notice = state.notice === undefined ? "" : colors.yellow(state.notice);
  const status = [notice, position].filter((part) => part.length > 0).join(colors.dim(" · "));
  return [
    clipVisible(` ${colors.dim(hints)}`, width),
    clipVisible(status.length === 0 ? "" : ` ${status}`, width),
  ];
}

function renderEmptyState(
  options: RenderTraceViewerOptions,
  theme: Theme,
  bodyRows: number,
): string[] {
  const [first, second] =
    options.tracingDisabled === true
      ? ["Tracing is disabled (EVE_TRACES=off).", "Re-enable it and spans stream in live."]
      : ["No local traces yet.", "Chat with your agent — spans stream in live."];
  const lines = Array.from({ length: bodyRows }, () => "");
  const top = Math.max(0, Math.floor(bodyRows / 2) - 1);
  if (top < bodyRows) lines[top] = theme.colors.bold(first);
  if (top + 1 < bodyRows) lines[top + 1] = theme.colors.dim(second);
  return lines;
}

function center(bodyRows: number, line: string): string[] {
  const top = Math.max(0, Math.floor(bodyRows / 2) - 1);
  const lines = Array.from({ length: bodyRows }, () => "");
  if (top < lines.length) lines[top] = line;
  return lines;
}

function padBody(lines: readonly string[], bodyRows: number): string[] {
  const padded = [...lines];
  while (padded.length < bodyRows) padded.push("");
  return padded.slice(0, bodyRows);
}

function joinPanels(
  left: string,
  leftWidth: number,
  separator: string,
  right: string,
  width: number,
): string {
  const rightWidth = Math.max(0, width - leftWidth - 1);
  return `${padTo(left, leftWidth)}${separator}${clipVisible(right, rightWidth)}`;
}

function joinRight(left: string, right: string, width: number): string {
  if (right.length === 0) return left;
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function padTo(line: string, width: number): string {
  const visible = visibleLength(line);
  return visible >= width ? clipVisible(line, width) : line + " ".repeat(width - visible);
}

function panelWidthFor(width: number): number {
  if (width < BODY_MIN_WIDTH + PANEL_MIN_WIDTH + 2) return 0;
  return Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, Math.floor(width * 0.42)),
    width - BODY_MIN_WIDTH - 1,
  );
}

function durationMs(start: bigint, end: bigint): number {
  return Math.max(0, Number(end - start) / 1_000_000);
}

function clockTime(nanoseconds: bigint): string {
  const date = new Date(Number(nanoseconds / 1_000_000n));
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
