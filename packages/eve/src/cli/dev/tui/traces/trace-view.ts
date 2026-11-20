import { formatElapsed } from "#cli/format-elapsed.js";
import {
  clipVisible,
  sliceVisible,
  stripAnsi,
  stripTerminalControls,
  visibleLength,
  wrapVisibleLine,
} from "#cli/ui/terminal-text.js";
import type { LocalTraceSpan } from "#tracing/local/trace-reader.js";
import { describeLocalTraceSpan } from "#tracing/local/trace-reader.js";

import type { Theme } from "../theme.js";
import { formatAttributeContent } from "./trace-content.js";
import { renderConversationItem } from "./trace-conversation.js";
import type { TraceViewerSurfaces } from "./trace-surfaces.js";
import type { TextSelectionRange, TraceViewerState } from "./trace-viewer-state.js";
import {
  TRACE_VIEWER_HEADER_ROWS,
  orderedTextSelection,
  selectedTraceViewerSpan,
} from "./trace-viewer-state.js";

const HEADER_ROWS = TRACE_VIEWER_HEADER_ROWS;
const FOOTER_ROWS = 3;
const BODY_MIN_WIDTH = 20;
const PANEL_MIN_WIDTH = 20;
const PANEL_MAX_WIDTH = 64;

interface TraceViewerFrame {
  readonly rows: readonly string[];
  readonly panelTotalRows: number;
  readonly timelineViewportRows: number;
  readonly panelViewportRows: number;
  readonly contentWidth: number;
}

interface RenderTraceViewerOptions {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly activeWindowEndNs?: bigint;
  readonly tracingDisabled?: boolean;
  readonly toast?: string;
  readonly surfaces?: TraceViewerSurfaces;
}

export function renderTraceViewer(
  state: TraceViewerState,
  options: RenderTraceViewerOptions,
): TraceViewerFrame {
  const { width, height, theme } = options;
  const chrome = chromeStyles(theme, options.surfaces);
  const bodyRows = Math.max(1, height - HEADER_ROWS - FOOTER_ROWS);
  const panelWidth = state.panelOpen ? panelWidthFor(width) : 0;
  const timelineWidth = Math.max(20, width - (panelWidth === 0 ? 0 : panelWidth + 1));

  const detailLines = panelDetailLines(state, panelWidth, theme, options.surfaces);
  const panelViewportRows = bodyRows;

  const rows: string[] = [];
  rows.push(...renderHeader(state, options));
  if (state.traces.length === 0) {
    rows.push(...renderEmptyState(options, theme, bodyRows));
  } else if (state.trace === undefined) {
    rows.push(...center(bodyRows, chrome.muted("Loading trace…")));
  } else {
    const body = renderConversation(state, options, timelineWidth, bodyRows);
    for (let index = 0; index < bodyRows; index += 1) {
      const left = body[index] ?? "";
      if (panelWidth === 0) {
        rows.push(left);
        continue;
      }
      let panelLine = detailLines[state.panelScroll + index] ?? "";
      if (state.textSelection !== undefined && state.textSelection.region === "panel") {
        panelLine = highlightSelection(
          panelLine,
          state.panelScroll + index,
          state.textSelection,
          panelWidth,
        );
      }
      rows.push(joinPanels(left, timelineWidth, panelLine, width));
    }
  }
  rows.push(...renderFooter(state, width, theme, options.surfaces));
  if (options.toast !== undefined) {
    overlayToast(rows, options.toast, width, theme, options.surfaces);
  }

  return {
    rows,
    panelTotalRows: detailLines.length,
    timelineViewportRows: bodyRows,
    panelViewportRows,
    contentWidth: timelineWidth,
  };
}

function chromeStyles(
  theme: Theme,
  surfaces: TraceViewerSurfaces | undefined,
): { readonly muted: (text: string) => string; readonly primary: (text: string) => string } {
  const active = theme.color ? surfaces : undefined;
  return {
    muted: active?.mutedText ?? theme.colors.dim,
    primary: active?.primaryText ?? ((text: string) => text),
  };
}

function overlayToast(
  rows: string[],
  message: string,
  width: number,
  theme: Theme,
  surfaces?: TraceViewerSurfaces,
): void {
  const text = stripTerminalControls(message);
  const inner = `  ${text}  `;
  const innerWidth = visibleLength(inner);
  const bar = theme.unicode ? "▌" : theme.glyph.rule;
  const active = theme.color ? surfaces : undefined;
  const surface = active === undefined ? "" : active.body;
  const primary = active?.primaryText ?? theme.colors.white;
  const close = theme.color ? "\x1b[0m" : "";
  const lines = [
    `${surface}${primary(bar)}${" ".repeat(innerWidth)}${close}`,
    `${surface}${primary(bar)}${primary(inner)}${close}`,
    `${surface}${primary(bar)}${" ".repeat(innerWidth)}${close}`,
  ];
  for (const [offset, line] of lines.entries()) {
    const index = HEADER_ROWS - 1 + offset;
    if (index >= rows.length) break;
    rows[index] = overlayRight(rows[index]!, line, width, 1);
  }
}

function overlayRight(row: string, segment: string, width: number, margin: number): string {
  const cut = Math.max(0, width - margin - visibleLength(segment));
  const rowWidth = visibleLength(row);
  const padded = rowWidth < cut ? row + " ".repeat(cut - rowWidth) : row;
  return `${sliceVisible(padded, cut)}\x1b[0m${segment}`;
}

const CONVERSATION_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
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
  options?: {
    readonly excludeKeys?: ReadonlySet<string>;
    readonly surfaces?: TraceViewerSurfaces;
  },
): string[] {
  const { colors } = theme;
  const { muted, primary } = chromeStyles(theme, options?.surfaces);
  const lines: string[] = [];
  const name = stripTerminalControls(span.name);
  lines.push(...wrapVisibleLine(colors.bold(primary(name)), innerWidth));
  const summary = describeLocalTraceSpan(span).map(stripTerminalControls);
  if (summary.length > 0) lines.push(muted(summary.join(", ")));
  lines.push("");

  const fact = (label: string, value: string): string => `${muted(label.padEnd(10))}${value}`;
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
    lines.push(muted("no attributes"));
  } else {
    lines.push(muted(`attributes (${keys.length})`));
    for (const key of keys) {
      const block = formatAttributeContent(key, span.attributes[key], colors.dim, innerWidth - 2);
      const cleanKey = stripTerminalControls(key);
      if (block.length === 1) {
        lines.push(...wrapVisibleLine(`${muted(cleanKey)} ${block[0]}`, innerWidth));
      } else {
        lines.push(muted(cleanKey));
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
  const { muted, primary } = chromeStyles(theme, options.surfaces);
  const segments: string[] = [];
  if (state.trace?.agentName !== undefined) {
    segments.push(stripTerminalControls(state.trace.agentName));
  }
  if (state.trace?.conversationId !== undefined) {
    segments.push(`conversation ${stripTerminalControls(state.trace.conversationId)}`);
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
  const title = `${colors.bold(primary(`${glyph.brand} traces`))}${
    segments.length === 0 ? "" : muted(` · ${segments.join(" · ")}`)
  }`;
  const position =
    state.traces.length === 0 ? "" : muted(`[${state.traceIndex + 1}/${state.traces.length}]`);
  const live = options.activeWindowEndNs !== undefined ? colors.green("● live") : "";
  const right = [live, position].filter((part) => part.length > 0).join(" ");
  const header = joinRight(
    ` ${clipVisible(title, Math.max(0, width - visibleLength(right) - 2))}`,
    right,
    width,
  );
  return ["", clipVisible(header, width), ""];
}

function renderConversation(
  state: TraceViewerState,
  options: RenderTraceViewerOptions,
  width: number,
  bodyRows: number,
): string[] {
  const { theme } = options;
  if (state.conversationItems.length === 0) {
    return [
      chromeStyles(theme, options.surfaces).muted(
        "  No conversation content in this trace; its export policy may have redacted it.",
      ),
    ];
  }
  const allLines = conversationLines(state, width, theme, options.surfaces);
  const visible = allLines.slice(state.scrollRow, state.scrollRow + bodyRows);
  if (state.textSelection === undefined || state.textSelection.region !== "conversation") {
    return visible;
  }
  return visible.map((line, index) =>
    highlightSelection(line, state.scrollRow + index, state.textSelection!, width),
  );
}

function conversationLines(
  state: TraceViewerState,
  width: number,
  theme: Theme,
  surfaces?: TraceViewerSurfaces,
): string[] {
  const allLines: string[] = [];
  for (let index = 0; index < state.conversationItems.length; index += 1) {
    allLines.push(
      ...renderConversationItem(
        state.conversationItems[index]!,
        width,
        theme,
        index === state.selectedRow,
        state.expandedItems.has(index),
        surfaces,
      ),
      "",
    );
  }
  return allLines;
}

function panelDetailLines(
  state: TraceViewerState,
  panelWidth: number,
  theme: Theme,
  surfaces?: TraceViewerSurfaces,
): string[] {
  const selected = selectedTraceViewerSpan(state);
  if (!state.panelOpen || panelWidth <= 0 || selected === undefined) return [];
  return [
    "",
    ...renderSpanDetail(selected, Math.max(16, panelWidth - 3), theme, {
      excludeKeys: CONVERSATION_CONTENT_KEYS,
      surfaces,
    }).map((line) => ` ${line}`),
  ];
}

export function conversationSelectionText(
  state: TraceViewerState,
  width: number,
  theme: Theme,
  selection: TextSelectionRange,
  surfaces?: TraceViewerSurfaces,
): string {
  return selectionText(conversationLines(state, width, theme, surfaces), selection);
}

export function panelSelectionText(
  state: TraceViewerState,
  totalWidth: number,
  theme: Theme,
  selection: TextSelectionRange,
): string {
  const panelWidth = state.panelOpen ? panelWidthFor(totalWidth) : 0;
  return selectionText(panelDetailLines(state, panelWidth, theme), selection);
}

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
  const rowWidth = visibleLength(row);
  const padded = rowWidth < to ? row + " ".repeat(to - rowWidth) : row;
  const prefix = sliceVisible(padded, from);
  const withSelection = sliceVisible(padded, to);
  const middle = withSelection.slice(prefix.length);
  const suffix = padded.slice(withSelection.length);
  if (middle.length === 0) return row;
  const inverted = middle.replaceAll("\x1b[0m", "\x1b[0m\x1b[7m");
  return `${prefix}\x1b[7m${inverted}\x1b[27m${suffix}`;
}

function renderFooter(
  state: TraceViewerState,
  width: number,
  theme: Theme,
  surfaces?: TraceViewerSurfaces,
): string[] {
  const { colors } = theme;
  const { muted } = chromeStyles(theme, surfaces);
  const [upDown, leftRight] = theme.unicode ? ["↑↓", "←→"] : ["^/v", "</>"];
  const hints = state.panelFocus
    ? `${upDown} scroll · tab cards · esc back`
    : `${upDown} select · ${leftRight} expand · enter attrs · tab focus · [ ] traces · q close`;
  const itemCount = state.conversationItems.length;
  const position = itemCount === 0 ? "" : muted(`item ${state.selectedRow + 1}/${itemCount}`);
  const notice = state.notice === undefined ? "" : colors.yellow(state.notice);
  const status = [notice, position].filter((part) => part.length > 0).join(muted(" · "));
  return [
    "",
    clipVisible(` ${muted(hints)}`, width),
    clipVisible(status.length === 0 ? "" : ` ${status}`, width),
  ];
}

function renderEmptyState(
  options: RenderTraceViewerOptions,
  theme: Theme,
  bodyRows: number,
): string[] {
  const { muted, primary } = chromeStyles(theme, options.surfaces);
  const [first, second] =
    options.tracingDisabled === true
      ? ["Tracing is disabled (EVE_TRACES=off).", "Re-enable it and spans stream in live."]
      : ["No local traces yet.", "Chat with your agent — spans stream in live."];
  return center(bodyRows, theme.colors.bold(primary(first)), muted(second));
}

function center(bodyRows: number, ...lines: string[]): string[] {
  const rows = Array.from({ length: bodyRows }, () => "");
  const top = Math.max(0, Math.floor(bodyRows / 2) - 1);
  lines.forEach((line, index) => {
    if (top + index < bodyRows) rows[top + index] = line;
  });
  return rows;
}

function joinPanels(left: string, leftWidth: number, right: string, width: number): string {
  const rightWidth = Math.max(0, width - leftWidth - 1);
  return `${padTo(left, leftWidth)} ${clipVisible(right, rightWidth)}`;
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
