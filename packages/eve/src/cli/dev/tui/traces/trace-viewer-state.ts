/**
 * Navigation state for the `/traces` conversation viewer — a pure reducer in
 * the style of `select-state.ts`: keys go in, a new state (plus an optional
 * `close` effect) comes out, and rendering lives elsewhere. Data updates
 * from the store poller arrive through {@link applyTraceList}/
 * {@link applyLoadedTrace} so a live trace can grow underneath an open
 * viewer without losing the user's selection.
 */

import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";

import type { ConversationItem } from "#cli/dev/tui/traces/trace-conversation.js";
import {
  buildConversationItems,
  conversationItemExpandable,
} from "#cli/dev/tui/traces/trace-conversation.js";
import type { TraceStoreEntry } from "#cli/dev/tui/traces/trace-store.js";
import type { TerminalKey } from "#cli/dev/tui/stream-format.js";

export interface TraceViewerState {
  /** Stored traces, most recent activity first. */
  readonly traces: readonly TraceStoreEntry[];
  /** Index into `traces` of the trace being viewed. */
  readonly traceIndex: number;
  /** The loaded trace, or `undefined` while it has no readable spans. */
  readonly trace?: LocalTrace;
  /** The trace re-told as conversation items (system/user/assistant/tool cards). */
  readonly conversationItems: readonly ConversationItem[];
  /** Conversation cards toggled open (the system card starts collapsed). */
  readonly expandedItems: ReadonlySet<number>;
  /** Index into `conversationItems` of the highlighted card. */
  readonly selectedRow: number;
  /** First conversation line painted (line-level scroll offset). */
  readonly scrollRow: number;
  readonly panelOpen: boolean;
  /** Whether ↑/↓ scroll the details drawer instead of moving the selection. */
  readonly panelFocus: boolean;
  readonly panelScroll: number;
  /** One-line status for edge cases (trace pruned, tracing disabled, …). */
  readonly notice?: string;
  /** Mouse drag selection over the conversation or drawer, in line/column cells. */
  readonly textSelection?: TextSelectionRange;
}

/**
 * One end of a text selection: line index + 0-based column, both relative
 * to the selection's region — absolute conversation lines for the cards,
 * absolute detail lines (and panel-content columns) for the drawer.
 */
export interface TextSelectionPoint {
  readonly line: number;
  readonly column: number;
}

/** A drag selection from anchor (press) to head (latest drag position). */
export interface TextSelectionRange {
  readonly anchor: TextSelectionPoint;
  readonly head: TextSelectionPoint;
  /** The pointer moved off the anchor cell — release copies instead of clicking. */
  readonly dragging: boolean;
  /** Where the drag started; the selection stays in that region. */
  readonly region: "conversation" | "panel";
}

/** Selection endpoints ordered top-to-bottom for rendering and extraction. */
export function orderedTextSelection(selection: TextSelectionRange): {
  start: TextSelectionPoint;
  end: TextSelectionPoint;
} {
  const { anchor, head } = selection;
  const anchorFirst =
    anchor.line < head.line || (anchor.line === head.line && anchor.column <= head.column);
  return anchorFirst ? { start: anchor, end: head } : { start: head, end: anchor };
}

/** Viewport metrics the controller measures so scrolling math stays pure. */
export interface TraceViewerKeyEnvironment {
  /** Body rows available to the conversation. */
  readonly timelineViewportRows: number;
  /** Body rows available to the detail panel. */
  readonly panelViewportRows: number;
  /** Total detail rows the panel would paint for the selected span. */
  readonly panelTotalRows: number;
  /** Body column width — card expandability is width-dependent. */
  readonly contentWidth: number;
  /**
   * Rendered height of each conversation card. The conversation viewport
   * scrolls by lines, not items — without these, long conversations overflow
   * the screen with no way to reach lower cards.
   */
  readonly conversationLineCounts?: readonly number[];
}

export interface TraceViewerKeyResult {
  readonly state: TraceViewerState;
  readonly effect?: "close";
  /** A completed drag selection to copy — the controller extracts and copies the text. */
  readonly copySelection?: TextSelectionRange;
}

export function createTraceViewerState(): TraceViewerState {
  return {
    traces: [],
    traceIndex: 0,
    conversationItems: [],
    expandedItems: new Set(),
    selectedRow: 0,
    scrollRow: 0,
    panelOpen: false,
    panelFocus: false,
    panelScroll: 0,
  };
}

export function selectedTraceViewerSpan(state: TraceViewerState): LocalTraceSpan | undefined {
  return state.conversationItems[state.selectedRow]?.span;
}

/** The number of selectable cards. */
export function traceViewerItemCount(state: TraceViewerState): number {
  return state.conversationItems.length;
}

/**
 * Applies a fresh trace listing. The viewed trace is kept by identity across
 * reorders (a live trace climbs the list as spans land); when it disappears,
 * selection falls back to the newest trace. `preferTraceId` wins on first
 * load — the viewer opens on the current chat session's trace.
 */
export function applyTraceList(
  state: TraceViewerState,
  entries: readonly TraceStoreEntry[],
  options: { readonly preferTraceId?: string } = {},
): TraceViewerState {
  const current = state.traces[state.traceIndex]?.traceId;
  // A one-time preference (current session, /traces <prefix>) wins over the
  // existing selection — the fallback was only chosen because the preferred
  // trace hadn't appeared yet.
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
  return {
    ...state,
    traces: entries,
    traceIndex,
    notice,
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

/**
 * Applies a freshly read trace. Selection follows the previously selected
 * card (span id + kind — cards can share spans) so live growth never jumps
 * the cursor; a pruned trace clears the view with a notice instead of
 * pretending stale data is current.
 */
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
    // Several cards can share one span (a model span also carries its
    // provider-executed tool cards), so match by occurrence, not first hit.
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

/** The one key handler: navigation, expansion, the details drawer, closing. */
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
      // Scroll wheel (SGR button 64/65): scroll the conversation viewport.
      if (key.action === "press" && (key.button === 64 || key.button === 65)) {
        const delta = key.button === 64 ? -3 : 3;
        return { state: scrollConversation(base, delta, environment) };
      }
      // Left press anchors a possible drag selection in whichever region the
      // pointer sits over — the cards or the open drawer; the click action
      // (and any copy) waits for release so dragging never toggles cards.
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
      // Motion with the left button held (SGR button 32) extends the
      // selection within the region the drag started in.
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
      // A drag that moved copies the selection; a stationary click acts.
      if (selection !== undefined && selection.dragging) {
        return { state: released, copySelection: selection };
      }
      // Left click selects and expands/collapses cards.
      const bodyIndex = key.y - 2; // one header row, 1-based coordinates
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
      // Recalculate the scroll offset: expanding changes card heights, so
      // the previous offset may leave the selected card's bottom cut off.
      const scrolled = { ...base, expandedItems };
      return { state: { ...scrolled, scrollRow: conversationScrollRow(scrolled, environment) } };
    }
    case "text": {
      if (key.framing === "bracketed-paste") return { state: base };
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
  return {
    ...state,
    traceIndex,
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

/** First line offset that keeps the selected card's last line visible. */
function conversationScrollRow(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
): number {
  const counts = environment.conversationLineCounts;
  if (counts === undefined) return state.scrollRow;
  const viewportRows = environment.timelineViewportRows;
  // Line range of the selected card (card lines + separator after each).
  let cardStart = 0;
  for (let index = 0; index < state.selectedRow; index += 1) {
    cardStart += (counts[index] ?? 1) + 1;
  }
  const cardHeight = counts[state.selectedRow] ?? 1;
  const cardEnd = cardStart + cardHeight;
  // Already visible? Keep the current offset.
  if (state.scrollRow <= cardStart && cardEnd <= state.scrollRow + viewportRows) {
    return state.scrollRow;
  }
  // Card taller than the viewport: align its top so the user can scroll
  // down through the rest. Otherwise scroll just enough to show the end.
  if (cardHeight > viewportRows) return cardStart;
  return Math.max(0, cardEnd - viewportRows);
}

/**
 * Maps 1-based terminal coordinates to a conversation cell: absolute line
 * (scroll offset applied) and 0-based column. Cells above the body, past
 * the conversation's last line, or right of the cards (the details drawer)
 * do not select.
 */
function conversationCellAt(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  x: number,
  y: number,
): TextSelectionPoint | undefined {
  const counts = environment.conversationLineCounts;
  if (counts === undefined || state.conversationItems.length === 0) return undefined;
  const bodyIndex = y - 2; // one header row, 1-based coordinates
  if (bodyIndex < 0 || bodyIndex >= environment.timelineViewportRows) return undefined;
  const column = x - 1;
  if (column < 0 || column >= environment.contentWidth) return undefined;
  let totalLines = 0;
  for (const count of counts) totalLines += count + 1;
  const line = state.scrollRow + bodyIndex;
  if (line >= totalLines) return undefined;
  return { column, line };
}

/**
 * Maps 1-based terminal coordinates to a detail-drawer cell: absolute
 * detail-line index (drawer scroll applied) and a column relative to the
 * drawer's content (the area right of the conversation and its separator).
 */
function panelCellAt(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  x: number,
  y: number,
): TextSelectionPoint | undefined {
  if (!state.panelOpen || environment.panelTotalRows === 0) return undefined;
  const bodyIndex = y - 2; // one header row, 1-based coordinates
  if (bodyIndex < 0 || bodyIndex >= environment.panelViewportRows) return undefined;
  const column = x - 1 - (environment.contentWidth + 1);
  if (column < 0) return undefined;
  const line = state.panelScroll + bodyIndex;
  if (line >= environment.panelTotalRows) return undefined;
  return { column, line };
}

/** Resolves a press to the region under the pointer: cards first, then drawer. */
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

/** Maps a click's body row to a card index, walking card heights + separators. */
function conversationItemAtBodyRow(
  state: TraceViewerState,
  environment: TraceViewerKeyEnvironment,
  bodyRow: number,
): number | undefined {
  const counts = environment.conversationLineCounts;
  if (counts === undefined) return undefined;
  const absoluteLine = state.scrollRow + bodyRow;
  let line = 0;
  for (let index = 0; index < state.conversationItems.length; index += 1) {
    const cardHeight = (counts[index] ?? 1) + 1; // card lines + separator
    if (absoluteLine < line + cardHeight) return index;
    line += cardHeight;
  }
  return undefined;
}

/** Scrolls the conversation viewport by `delta` lines (mouse wheel). */
function scrollConversation(
  state: TraceViewerState,
  delta: number,
  environment: TraceViewerKeyEnvironment,
): TraceViewerState {
  const counts = environment.conversationLineCounts;
  if (counts === undefined || state.conversationItems.length === 0) return state;
  const viewportRows = environment.timelineViewportRows;
  // Total lines including separators.
  let totalLines = 0;
  for (const count of counts) totalLines += count + 1;
  const maxScroll = Math.max(0, totalLines - viewportRows);
  const scrollRow = Math.min(maxScroll, Math.max(0, state.scrollRow + delta));
  if (scrollRow === state.scrollRow) return state;
  // The selection stays on the same card even when it scrolls out of view;
  // arrow keys re-scroll to bring it back (conversationScrollRow).
  return { ...state, scrollRow };
}
