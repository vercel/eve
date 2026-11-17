import type { LocalTrace, LocalTraceSpan } from "#tracing/local/trace-reader.js";

import type { ConversationItem } from "#cli/dev/tui/traces/trace-conversation.js";
import {
  buildConversationItems,
  conversationItemExpandable,
} from "#cli/dev/tui/traces/trace-conversation.js";
import type { TraceStoreEntry } from "#cli/dev/tui/traces/trace-store.js";
import type { TerminalKey } from "#cli/dev/tui/stream-format.js";

export const TRACE_VIEWER_HEADER_ROWS = 3;

export interface TraceViewerState {
  readonly traces: readonly TraceStoreEntry[];
  readonly traceIndex: number;
  readonly trace?: LocalTrace;
  readonly conversationItems: readonly ConversationItem[];
  readonly expandedItems: ReadonlySet<number>;
  readonly selectedRow: number;
  readonly scrollRow: number;
  readonly panelOpen: boolean;
  readonly panelFocus: boolean;
  readonly panelScroll: number;
  readonly notice?: string;
  readonly textSelection?: TextSelectionRange;
}

export interface TextSelectionPoint {
  readonly line: number;
  readonly column: number;
}

export interface TextSelectionRange {
  readonly anchor: TextSelectionPoint;
  readonly head: TextSelectionPoint;
  readonly dragging: boolean;
  readonly region: "conversation" | "panel";
}

export function orderedTextSelection(selection: TextSelectionRange): {
  start: TextSelectionPoint;
  end: TextSelectionPoint;
} {
  const { anchor, head } = selection;
  const anchorFirst =
    anchor.line < head.line || (anchor.line === head.line && anchor.column <= head.column);
  return anchorFirst ? { start: anchor, end: head } : { start: head, end: anchor };
}

export interface TraceViewerKeyEnvironment {
  readonly timelineViewportRows: number;
  readonly panelViewportRows: number;
  readonly panelTotalRows: number;
  readonly contentWidth: number;
  readonly conversationLineCounts?: readonly number[];
}

interface TraceViewerKeyResult {
  readonly state: TraceViewerState;
  readonly effect?: "close";
  readonly copySelection?: TextSelectionRange;
}

export function createTraceViewerState(): TraceViewerState {
  return { ...clearedTraceView(), traces: [], traceIndex: 0 };
}

function clearedTraceView(): Pick<
  TraceViewerState,
  | "conversationItems"
  | "expandedItems"
  | "panelFocus"
  | "panelOpen"
  | "panelScroll"
  | "scrollRow"
  | "selectedRow"
  | "textSelection"
  | "trace"
> {
  return {
    trace: undefined,
    conversationItems: [],
    expandedItems: new Set(),
    selectedRow: 0,
    scrollRow: 0,
    panelOpen: false,
    panelFocus: false,
    panelScroll: 0,
    textSelection: undefined,
  };
}

export function selectedTraceViewerSpan(state: TraceViewerState): LocalTraceSpan | undefined {
  return state.conversationItems[state.selectedRow]?.span;
}

function traceViewerItemCount(state: TraceViewerState): number {
  return state.conversationItems.length;
}

export function applyTraceList(
  state: TraceViewerState,
  entries: readonly TraceStoreEntry[],
  options: { readonly preferTraceId?: string } = {},
): TraceViewerState {
  const current = state.traces[state.traceIndex]?.traceId;
  let traceIndex =
    options.preferTraceId !== undefined
      ? entries.findIndex((entry) => entry.traceId === options.preferTraceId)
      : -1;
  if (traceIndex === -1) {
    traceIndex = current === undefined ? -1 : entries.findIndex((e) => e.traceId === current);
  }
  if (traceIndex === -1) traceIndex = entries.length === 0 ? 0 : Math.max(0, state.traceIndex);
  if (traceIndex >= entries.length) traceIndex = Math.max(0, entries.length - 1);
  const switched = entries[traceIndex]?.traceId !== current;
  const notice =
    entries.length === 0
      ? (state.notice ?? "No local traces yet — chat with your agent and spans stream in live.")
      : state.notice?.startsWith("No local traces")
        ? undefined
        : state.notice;
  if (!switched) return { ...state, traces: entries, traceIndex, notice };
  return { ...state, ...clearedTraceView(), traces: entries, traceIndex, notice };
}

export function applyLoadedTrace(
  state: TraceViewerState,
  trace: LocalTrace | undefined,
): TraceViewerState {
  if (trace === undefined) {
    if (state.trace === undefined) return state;
    return {
      ...state,
      trace: undefined,
      conversationItems: [],
      selectedRow: 0,
      scrollRow: 0,
      panelOpen: false,
      panelFocus: false,
      panelScroll: 0,
      notice: "This trace was pruned — pick another with [ and ].",
    };
  }
  const selectedSpanId = selectedTraceViewerSpan(state)?.spanId;
  const selectedItemKind = state.conversationItems[state.selectedRow]?.kind;
  const conversationItems = buildConversationItems(trace);
  let selectedRow: number;
  if (selectedSpanId === undefined) {
    selectedRow = state.selectedRow;
  } else {
    const matches = (item: ConversationItem): boolean =>
      item.span.spanId === selectedSpanId && item.kind === selectedItemKind;
    const occurrence = state.conversationItems.slice(0, state.selectedRow).filter(matches).length;
    const indices = conversationItems.flatMap((item, index) => (matches(item) ? [index] : []));
    selectedRow = indices[Math.min(occurrence, indices.length - 1)] ?? -1;
  }
  if (selectedRow === -1) {
    selectedRow = Math.min(state.selectedRow, conversationItems.length - 1);
  }
  if (selectedRow < 0) selectedRow = 0;
  const notice = state.notice?.startsWith("This trace was pruned") ? undefined : state.notice;
  return { ...state, trace, conversationItems, selectedRow, notice };
}

export function reduceTraceViewerKey(
  state: TraceViewerState,
  key: TerminalKey,
  environment: TraceViewerKeyEnvironment,
): TraceViewerKeyResult {
  const panelMaxScroll = Math.max(0, environment.panelTotalRows - environment.panelViewportRows);
  const base: TraceViewerState =
    state.panelScroll > panelMaxScroll ? { ...state, panelScroll: panelMaxScroll } : state;

  switch (key.type) {
    case "escape": {
      if (base.textSelection !== undefined) {
        return { state: { ...base, textSelection: undefined } };
      }
      if (base.panelFocus) return { state: { ...base, panelFocus: false } };
      if (base.panelOpen) return { state: { ...base, panelOpen: false, panelScroll: 0 } };
      return { state: base, effect: "close" };
    }
    case "ctrl-c": {
      return { state: base, effect: "close" };
    }
    case "mouse": {
      if (key.action === "press" && (key.button === 64 || key.button === 65)) {
        const delta = key.button === 64 ? -3 : 3;
        if (base.panelOpen && key.x - 1 >= environment.contentWidth) {
          const panelScroll = Math.min(panelMaxScroll, Math.max(0, base.panelScroll + delta));
          return { state: { ...base, panelScroll } };
        }
        return { state: scrollConversation(base, delta, environment) };
      }
      if (key.action === "press" && key.button === 0) {
        const anchored = selectionCellAt(base, environment, key.x, key.y);
        if (anchored === undefined) return { state: { ...base, textSelection: undefined } };
        return {
          state: {
            ...base,
            textSelection: {
              anchor: anchored.point,
              head: anchored.point,
              dragging: false,
              region: anchored.region,
            },
          },
        };
      }
      if (key.action === "press" && key.button === 32) {
        if (base.textSelection === undefined) return { state: base };
        const point =
          base.textSelection.region === "panel"
            ? panelCellAt(base, environment, key.x, key.y)
            : conversationCellAt(base, environment, key.x, key.y);
        if (point === undefined) return { state: base };
        const dragging =
          base.textSelection.dragging ||
          point.line !== base.textSelection.anchor.line ||
          point.column !== base.textSelection.anchor.column;
        return {
          state: { ...base, textSelection: { ...base.textSelection, head: point, dragging } },
        };
      }
      if (key.action !== "release" || key.button !== 0) return { state: base };
      const selection = base.textSelection;
      const released: TraceViewerState = { ...base, textSelection: undefined };
      if (selection !== undefined && selection.dragging) {
        return { state: released, copySelection: selection };
      }
      const bodyIndex = key.y - 1 - TRACE_VIEWER_HEADER_ROWS;
      if (bodyIndex < 0) return { state: released };
      const itemIndex = conversationItemAtBodyRow(released, environment, bodyIndex);
      if (itemIndex === undefined) return { state: released };
      const item = released.conversationItems[itemIndex];
      const expandedItems = new Set(released.expandedItems);
      if (
        item !== undefined &&
        !expandedItems.has(itemIndex) &&
        conversationItemExpandable(item, environment.contentWidth)
      ) {
        expandedItems.add(itemIndex);
      } else {
        expandedItems.delete(itemIndex);
      }
      return { state: { ...released, selectedRow: itemIndex, expandedItems } };
    }
    case "enter": {
      if (traceViewerItemCount(base) === 0) return { state: base };
      if (base.panelOpen) return { state: { ...base, panelOpen: false, panelFocus: false } };
      return { state: { ...base, panelOpen: true, panelScroll: 0 } };
    }
    case "tab": {
      if (!base.panelOpen) return { state: base };
      return { state: { ...base, panelFocus: !base.panelFocus } };
    }
    case "up":
    case "ctrl-p": {
      if (base.panelFocus) {
        return { state: { ...base, panelScroll: Math.max(0, base.panelScroll - 1) } };
      }
      return { state: moveSelection(base, -1, environment) };
    }
    case "down":
    case "ctrl-n": {
      if (base.panelFocus) {
        return { state: { ...base, panelScroll: Math.min(panelMaxScroll, base.panelScroll + 1) } };
      }
      return { state: moveSelection(base, 1, environment) };
    }
    case "home": {
      if (base.panelFocus) return { state: { ...base, panelScroll: 0 } };
      return { state: moveSelection(base, -base.selectedRow, environment) };
    }
    case "end": {
      if (base.panelFocus) return { state: { ...base, panelScroll: panelMaxScroll } };
      return {
        state: moveSelection(base, traceViewerItemCount(base) - 1 - base.selectedRow, environment),
      };
    }
    case "left":
    case "right": {
      if (base.panelFocus) return { state: base };
      const item = base.conversationItems[base.selectedRow];
      if (
        item === undefined ||
        (!base.expandedItems.has(base.selectedRow) &&
          !conversationItemExpandable(item, environment.contentWidth))
      ) {
        return { state: base };
      }
      const expandedItems = new Set(base.expandedItems);
      if (expandedItems.has(base.selectedRow)) {
        expandedItems.delete(base.selectedRow);
      } else {
        expandedItems.add(base.selectedRow);
      }
      const scrolled = { ...base, expandedItems };
      return { state: { ...scrolled, scrollRow: conversationScrollRow(scrolled, environment) } };
    }
    case "text": {
      if (key.framing === "bracketed-paste") return { state: base };
      if (key.value === "k") {
        if (base.panelFocus) {
          return { state: { ...base, panelScroll: Math.max(0, base.panelScroll - 1) } };
        }
        return { state: moveSelection(base, -1, environment) };
      }
      if (key.value === "j") {
        if (base.panelFocus) {
          return {
            state: { ...base, panelScroll: Math.min(panelMaxScroll, base.panelScroll + 1) },
          };
        }
        return { state: moveSelection(base, 1, environment) };
      }
      if (key.value === "q") return { state: base, effect: "close" };
      if (key.value === "[" || key.value === "]") {
        const delta = key.value === "[" ? 1 : -1;
        return { state: switchTrace(base, delta) };
      }
      return { state: base };
    }
    default:
      return { state: base };
  }
}

function switchTrace(state: TraceViewerState, delta: number): TraceViewerState {
  if (state.traces.length === 0) return state;
  const traceIndex = Math.min(Math.max(0, state.traceIndex + delta), state.traces.length - 1);
  if (traceIndex === state.traceIndex) return state;
  return { ...state, ...clearedTraceView(), traceIndex };
}

function moveSelection(
  state: TraceViewerState,
  delta: number,
  environment: TraceViewerKeyEnvironment,
): TraceViewerState {
  const itemCount = traceViewerItemCount(state);
  if (itemCount === 0) return state;
  const selectedRow = Math.min(Math.max(0, state.selectedRow + delta), itemCount - 1);
  return {
    ...state,
    selectedRow,
    panelScroll: 0,
    scrollRow: conversationScrollRow({ ...state, selectedRow }, environment),
  };
}

function cardLineOffsets(state: TraceViewerState, counts: readonly number[]): number[] {
  const offsets = [0];
  for (let index = 0; index < state.conversationItems.length; index += 1) {
    offsets.push(offsets[index]! + (counts[index] ?? 1) + 1);
  }
  return offsets;
}

function conversationLineTotal(state: TraceViewerState, counts: readonly number[]): number {
  const offsets = cardLineOffsets(state, counts);
  return offsets[offsets.length - 1]!;
}

function conversationScrollRow(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
): number {
  const counts = environment.conversationLineCounts;
  if (counts === undefined) return state.scrollRow;
  const viewportRows = environment.timelineViewportRows;
  const offsets = cardLineOffsets(state, counts);
  const cardStart = offsets[state.selectedRow] ?? 0;
  const cardHeight = counts[state.selectedRow] ?? 1;
  const cardEnd = cardStart + cardHeight;
  if (state.scrollRow <= cardStart && cardEnd <= state.scrollRow + viewportRows) {
    return state.scrollRow;
  }
  if (cardHeight > viewportRows) return cardStart;
  return Math.max(0, cardEnd - viewportRows);
}

function conversationCellAt(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  x: number,
  y: number,
): TextSelectionPoint | undefined {
  const counts = environment.conversationLineCounts;
  if (counts === undefined || state.conversationItems.length === 0) return undefined;
  const bodyIndex = y - 1 - TRACE_VIEWER_HEADER_ROWS;
  if (bodyIndex < 0 || bodyIndex >= environment.timelineViewportRows) return undefined;
  const column = x - 1;
  if (column < 0 || column >= environment.contentWidth) return undefined;
  const totalLines = conversationLineTotal(state, counts);
  const line = state.scrollRow + bodyIndex;
  if (line >= totalLines) return undefined;
  return { column, line };
}

function panelCellAt(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  x: number,
  y: number,
): TextSelectionPoint | undefined {
  if (!state.panelOpen || environment.panelTotalRows === 0) return undefined;
  const bodyIndex = y - 1 - TRACE_VIEWER_HEADER_ROWS;
  if (bodyIndex < 0 || bodyIndex >= environment.panelViewportRows) return undefined;
  const column = x - 1 - (environment.contentWidth + 1);
  if (column < 0) return undefined;
  const line = state.panelScroll + bodyIndex;
  if (line >= environment.panelTotalRows) return undefined;
  return { column, line };
}

function selectionCellAt(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  x: number,
  y: number,
):
  | { readonly point: TextSelectionPoint; readonly region: TextSelectionRange["region"] }
  | undefined {
  const conversation = conversationCellAt(state, environment, x, y);
  if (conversation !== undefined) return { point: conversation, region: "conversation" };
  const panel = panelCellAt(state, environment, x, y);
  if (panel !== undefined) return { point: panel, region: "panel" };
  return undefined;
}

function conversationItemAtBodyRow(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  bodyRow: number,
): number | undefined {
  const counts = environment.conversationLineCounts;
  if (counts === undefined) return undefined;
  const absoluteLine = state.scrollRow + bodyRow;
  const offsets = cardLineOffsets(state, counts);
  for (let index = 0; index < state.conversationItems.length; index += 1) {
    if (absoluteLine < offsets[index + 1]!) return index;
  }
  return undefined;
}

function scrollConversation(
  state: TraceViewerState,
  delta: number,
  environment: TraceViewerKeyEnvironment,
): TraceViewerState {
  const counts = environment.conversationLineCounts;
  if (counts === undefined || state.conversationItems.length === 0) return state;
  const viewportRows = environment.timelineViewportRows;
  const maxScroll = Math.max(0, conversationLineTotal(state, counts) - viewportRows);
  const scrollRow = Math.min(maxScroll, Math.max(0, state.scrollRow + delta));
  if (scrollRow === state.scrollRow) return state;
  return { ...state, scrollRow };
}
