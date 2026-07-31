import { describe, expect, it } from "vitest";

import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";

import type { TraceStoreEntry } from "./trace-store.js";
import type { TerminalKey } from "../stream-format.js";
import {
  applyLoadedTrace,
  applyTraceList,
  createTraceViewerState,
  reduceTraceViewerKey,
} from "./trace-viewer-state.js";

let spanSequence = 0;

function span(overrides: Partial<LocalTraceSpan> = {}): LocalTraceSpan {
  spanSequence += 1;
  const startTimeNs = overrides.startTimeNs ?? BigInt(spanSequence) * 1_000_000n;
  return {
    attributes: {},
    endTimeNs: startTimeNs + 500_000n,
    name: `span-${spanSequence}`,
    spanId: String(spanSequence).padStart(16, "0"),
    startTimeNs,
    statusCode: 0,
    traceId: "t".repeat(32),
    ...overrides,
  };
}

function trace(spans: readonly LocalTraceSpan[], traceId = "t".repeat(32)): LocalTrace {
  const starts = spans.map((s) => s.startTimeNs);
  const ends = spans.map((s) => s.endTimeNs);
  return {
    endTimeNs: ends.reduce((a, b) => (b > a ? b : a), 0n),
    sessionIds: [],
    spans,
    startTimeNs: starts.reduce((a, b) => (b < a ? b : a), starts[0] ?? 0n),
    traceId,
  };
}

/** A turn with a user message, an assistant reply, and a tool call. */
function conversationTrace(options: { readonly longReply?: boolean } = {}): LocalTrace {
  const turn = span({ name: "agent.turn", spanId: "a".repeat(16) });
  const step = span({ name: "agent.step", spanId: "b".repeat(16), parentSpanId: turn.spanId });
  const model = span({
    name: "ai.streamText.doStream",
    spanId: "c".repeat(16),
    parentSpanId: step.spanId,
    attributes: {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "ai.response.text": options.longReply === true ? "a long reply. ".repeat(60) : "reply",
    },
  });
  const action = span({ name: "agent.action", spanId: "d".repeat(16), parentSpanId: step.spanId });
  const toolCall = span({
    name: "ai.toolCall",
    spanId: "e".repeat(16),
    parentSpanId: action.spanId,
    attributes: { "gen_ai.tool.name": "get_weather" },
  });
  return trace([turn, step, model, action, toolCall]);
}

function entry(traceId: string, lastActivityMs = 0): TraceStoreEntry {
  return { traceId, lastActivityMs };
}

const ENV = {
  timelineViewportRows: 10,
  panelViewportRows: 10,
  panelTotalRows: 30,
  contentWidth: 80,
};

function key(type: TerminalKey["type"], value?: string): TerminalKey {
  if (type === "text") return { type: "text", value: value ?? "", framing: "unframed" };
  return { type } as TerminalKey;
}

describe("reduceTraceViewerKey", () => {
  it("moves the selection with up/down and clamps at the ends", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const count = state.conversationItems.length;
    expect(count).toBeGreaterThan(1);
    state = reduceTraceViewerKey(state, key("up"), ENV).state;
    expect(state.selectedRow).toBe(0);
    for (let index = 0; index < count + 2; index += 1) {
      state = reduceTraceViewerKey(state, key("down"), ENV).state;
    }
    expect(state.selectedRow).toBe(count - 1);
    state = reduceTraceViewerKey(state, key("up"), ENV).state;
    expect(state.selectedRow).toBe(count - 2);
  });

  it("jumps home and end", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = reduceTraceViewerKey(state, key("end"), ENV).state;
    expect(state.selectedRow).toBe(state.conversationItems.length - 1);
    state = reduceTraceViewerKey(state, key("home"), ENV).state;
    expect(state.selectedRow).toBe(0);
  });

  it("opens the details drawer with enter and closes with enter and escape", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = reduceTraceViewerKey(state, key("enter"), ENV).state;
    expect(state.panelOpen).toBe(true);
    state = reduceTraceViewerKey(state, key("enter"), ENV).state;
    expect(state.panelOpen).toBe(false);
    state = reduceTraceViewerKey(state, key("enter"), ENV).state;
    state = reduceTraceViewerKey(state, key("escape"), ENV).state;
    expect(state.panelOpen).toBe(false);
  });

  it("tab moves focus into the drawer so arrows scroll it", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = reduceTraceViewerKey(state, key("enter"), ENV).state;
    state = reduceTraceViewerKey(state, key("tab"), ENV).state;
    expect(state.panelFocus).toBe(true);
    state = reduceTraceViewerKey(state, key("down"), ENV).state;
    expect(state.panelScroll).toBe(1);
    expect(state.selectedRow).toBe(0);
    state = reduceTraceViewerKey(state, key("escape"), ENV).state;
    expect(state.panelFocus).toBe(false);
    expect(state.panelOpen).toBe(true);
  });

  it("clamps drawer scroll to the content height", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = reduceTraceViewerKey(state, key("enter"), ENV).state;
    state = reduceTraceViewerKey(state, key("tab"), ENV).state;
    for (let index = 0; index < 50; index += 1) {
      state = reduceTraceViewerKey(state, key("down"), ENV).state;
    }
    expect(state.panelScroll).toBe(20);
  });

  it("closes the viewer on q, ctrl-c, and escape with the drawer closed", () => {
    const state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    expect(reduceTraceViewerKey(state, key("text", "q"), ENV).effect).toBe("close");
    expect(reduceTraceViewerKey(state, key("ctrl-c"), ENV).effect).toBe("close");
    expect(reduceTraceViewerKey(state, key("escape"), ENV).effect).toBe("close");
  });

  it("switches traces with [ and ], clamped to the list", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = applyTraceList(state, [entry("a".repeat(32)), entry("b".repeat(32))]);
    state = reduceTraceViewerKey(state, key("text", "["), ENV).state;
    expect(state.traceIndex).toBe(1);
    state = reduceTraceViewerKey(state, key("text", "["), ENV).state;
    expect(state.traceIndex).toBe(1);
    expect(state.conversationItems).toEqual([]);
    state = reduceTraceViewerKey(state, key("text", "]"), ENV).state;
    expect(state.traceIndex).toBe(0);
  });

  it("only expands conversation cards whose content is capped", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const assistantIndex = state.conversationItems.findIndex((item) => item.kind === "assistant");
    state = { ...state, selectedRow: assistantIndex };

    // A short reply fits the cap: ←/→ is a no-op, nothing to expand.
    state = reduceTraceViewerKey(state, key("right"), ENV).state;
    expect(state.expandedItems.has(assistantIndex)).toBe(false);

    // A long reply truncates: it can expand, and collapses back.
    state = applyLoadedTrace(state, conversationTrace({ longReply: true }));
    state = reduceTraceViewerKey(state, key("right"), ENV).state;
    expect(state.expandedItems.has(assistantIndex)).toBe(true);
    state = reduceTraceViewerKey(state, key("left"), ENV).state;
    expect(state.expandedItems.has(assistantIndex)).toBe(false);
  });

  it("expands and collapses cards on mouse clicks (press + release in place)", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace({ longReply: true }));
    const env = {
      ...ENV,
      conversationLineCounts: state.conversationItems.map(() => 6),
    };
    const assistantIndex = state.conversationItems.findIndex((item) => item.kind === "assistant");
    // Cards occupy 7 lines each (6 + separator); assistant starts at line
    // assistantIndex*7. Click one row into it (y=4 is first body row — three
    // header rows — so bodyRow = clickY-4 maps to line scrollRow+bodyRow).
    const clickY = 4 + assistantIndex * 7 + 1;
    const click = (): void => {
      state = reduceTraceViewerKey(
        state,
        { type: "mouse", action: "press", button: 0, x: 10, y: clickY },
        env,
      ).state;
      state = reduceTraceViewerKey(
        state,
        { type: "mouse", action: "release", button: 0, x: 10, y: clickY },
        env,
      ).state;
    };

    click();
    expect(state.selectedRow).toBe(assistantIndex);
    expect(state.expandedItems.has(assistantIndex)).toBe(true);

    click();
    expect(state.expandedItems.has(assistantIndex)).toBe(false);

    // A press alone (a drag may follow) is not a click.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 0, x: 10, y: clickY },
      env,
    ).state;
    expect(state.expandedItems.has(assistantIndex)).toBe(false);
  });

  it("selects and copies from the details drawer when the drag starts there", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const env = { ...ENV, conversationLineCounts: state.conversationItems.map(() => 6) };
    state = reduceTraceViewerKey(state, key("enter"), env).state;
    expect(state.panelOpen).toBe(true);
    // Press right of the cards (contentWidth 80 + separator): drawer cell
    // columns are relative to the drawer's content area.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 0, x: 85, y: 5 },
      env,
    ).state;
    expect(state.textSelection).toEqual({
      anchor: { line: 1, column: 3 },
      head: { line: 1, column: 3 },
      dragging: false,
      region: "panel",
    });
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 32, x: 90, y: 7 },
      env,
    ).state;
    const result = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "release", button: 0, x: 90, y: 7 },
      env,
    );
    expect(result.copySelection).toEqual({
      anchor: { line: 1, column: 3 },
      head: { line: 3, column: 8 },
      dragging: true,
      region: "panel",
    });
    expect(result.state.textSelection).toBeUndefined();
  });

  it("does not anchor a selection right of the cards when the drawer is closed", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const env = { ...ENV, conversationLineCounts: state.conversationItems.map(() => 6) };
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 0, x: 85, y: 5 },
      env,
    ).state;
    expect(state.textSelection).toBeUndefined();
  });

  it("scrolls the drawer with the wheel when the pointer is over it", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const env = { ...ENV, conversationLineCounts: state.conversationItems.map(() => 6) };
    state = reduceTraceViewerKey(state, key("enter"), env).state;
    expect(state.panelOpen).toBe(true);
    // Pointer right of the conversation (contentWidth 80): the drawer scrolls.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 65, x: 90, y: 5 },
      env,
    ).state;
    expect(state.panelScroll).toBe(3);
    expect(state.scrollRow).toBe(0);
    // Wheel back up clamps at the top.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 64, x: 90, y: 5 },
      env,
    ).state;
    expect(state.panelScroll).toBe(0);
    // Over the conversation, the wheel scrolls the cards as before.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 65, x: 10, y: 5 },
      env,
    ).state;
    expect(state.panelScroll).toBe(0);
  });

  it("copies a drag selection on release instead of clicking", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace({ longReply: true }));
    const env = {
      ...ENV,
      conversationLineCounts: state.conversationItems.map(() => 6),
    };

    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 0, x: 5, y: 5 },
      env,
    ).state;
    expect(state.textSelection).toEqual({
      anchor: { line: 1, column: 4 },
      head: { line: 1, column: 4 },
      dragging: false,
      region: "conversation",
    });

    // Motion with the left button held (SGR button 32) extends the selection.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 32, x: 20, y: 7 },
      env,
    ).state;
    expect(state.textSelection).toEqual({
      anchor: { line: 1, column: 4 },
      head: { line: 3, column: 19 },
      dragging: true,
      region: "conversation",
    });

    const result = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "release", button: 0, x: 20, y: 7 },
      env,
    );
    expect(result.copySelection).toEqual({
      anchor: { line: 1, column: 4 },
      head: { line: 3, column: 19 },
      dragging: true,
      region: "conversation",
    });
    expect(result.state.textSelection).toBeUndefined();
    // The drag did not toggle any card.
    expect(result.state.expandedItems.size).toBe(0);
  });

  it("escape clears an in-flight selection without closing the viewer", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    const env = { ...ENV, conversationLineCounts: state.conversationItems.map(() => 6) };
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 0, x: 5, y: 4 },
      env,
    ).state;
    expect(state.textSelection).toBeDefined();
    const result = reduceTraceViewerKey(state, key("escape"), env);
    expect(result.effect).toBeUndefined();
    expect(result.state.textSelection).toBeUndefined();
  });

  it("scrolls the viewport on mouse wheel events", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    // 10 cards, each 5 lines + separator; viewport holds 12 lines.
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...state.conversationItems[state.conversationItems.length - 1]!,
      span: {
        ...state.conversationItems[state.conversationItems.length - 1]!.span,
        spanId: String(index).padStart(16, "0"),
      },
    }));
    state = { ...state, conversationItems: items };
    const env = {
      ...ENV,
      timelineViewportRows: 12,
      conversationLineCounts: items.map(() => 5),
    };
    expect(state.scrollRow).toBe(0);
    // Wheel down (button 65): scroll forward.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 65, x: 10, y: 5 },
      env,
    ).state;
    expect(state.scrollRow).toBe(3);
    // The selection stays on the same card even when it scrolls out of view.
    expect(state.selectedRow).toBe(0);
    // Wheel up (button 64): scroll back.
    state = reduceTraceViewerKey(
      state,
      { type: "mouse", action: "press", button: 64, x: 10, y: 5 },
      env,
    ).state;
    expect(state.scrollRow).toBe(0);
    expect(state.selectedRow).toBe(0);
    // Clamps at the end.
    for (let i = 0; i < 20; i += 1) {
      state = reduceTraceViewerKey(
        state,
        { type: "mouse", action: "press", button: 65, x: 10, y: 5 },
        env,
      ).state;
    }
    // Total lines = 10*6 = 60; max scroll = 60-12 = 48.
    expect(state.scrollRow).toBe(48);
    expect(state.selectedRow).toBe(0);
  });

  it("scrolls the conversation by line offset, including separators, to fit the last card", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    // Pretend the trace holds several turns' worth of cards by cloning items.
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...state.conversationItems[state.conversationItems.length - 1]!,
      span: {
        ...state.conversationItems[state.conversationItems.length - 1]!.span,
        spanId: String(index).padStart(16, "0"),
      },
    }));
    state = { ...state, conversationItems: items };
    // Each card is 5 lines + 1 separator; the viewport holds 12 lines.
    const env = {
      ...ENV,
      timelineViewportRows: 12,
      conversationLineCounts: items.map(() => 5),
    };
    for (let index = 0; index < 9; index += 1) {
      state = reduceTraceViewerKey(state, key("down"), env).state;
    }
    expect(state.selectedRow).toBe(9);
    // Card 9 starts at line 9*6=54; it ends at 54+5=59. To fit 59 in a
    // 12-line viewport, scroll to 59-12=47 (line offset into all cards).
    expect(state.scrollRow).toBe(47);
    // One more down at the end is a no-op but keeps the card in view.
    state = reduceTraceViewerKey(state, key("down"), env).state;
    expect(state.scrollRow).toBe(47);
  });
});

describe("applyTraceList", () => {
  it("keeps the viewed trace by identity when the list reorders", () => {
    const initial = applyTraceList(createTraceViewerState(), [
      entry("a".repeat(32), 2),
      entry("b".repeat(32), 1),
    ]);
    expect(initial.traceIndex).toBe(0);
    const reordered = applyTraceList({ ...initial, traceIndex: 1 }, [
      entry("b".repeat(32), 3),
      entry("a".repeat(32), 2),
    ]);
    expect(reordered.traces[reordered.traceIndex]!.traceId).toBe("b".repeat(32));
  });

  it("prefers the requested trace id on first load", () => {
    const state = applyTraceList(
      createTraceViewerState(),
      [entry("a".repeat(32)), entry("b".repeat(32))],
      { preferTraceId: "b".repeat(32) },
    );
    expect(state.traceIndex).toBe(1);
  });

  it("selects the preferred trace even when a fallback is already viewed", () => {
    // The viewer opened with a fallback trace because the preferred one
    // hadn't appeared yet. Once it shows up, the preference must win.
    let state = applyTraceList(createTraceViewerState(), [entry("a".repeat(32))]);
    expect(state.traceIndex).toBe(0);
    state = applyTraceList(state, [entry("a".repeat(32)), entry("b".repeat(32))], {
      preferTraceId: "b".repeat(32),
    });
    expect(state.traceIndex).toBe(1);
  });

  it("resets the view when the viewed trace disappears", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = { ...state, selectedRow: 1, panelOpen: true };
    state = applyTraceList(state, [entry("b".repeat(32))]);
    expect(state.traceIndex).toBe(0);
    expect(state.trace).toBeUndefined();
    expect(state.conversationItems).toEqual([]);
    expect(state.panelOpen).toBe(false);
  });

  it("announces an empty spool and clears the notice when traces arrive", () => {
    let state = applyTraceList(createTraceViewerState(), []);
    expect(state.notice).toContain("No local traces");
    state = applyTraceList(state, [entry("a".repeat(32))]);
    expect(state.notice).toBeUndefined();
  });
});

describe("applyLoadedTrace", () => {
  it("keeps the conversation selection when cards share one span", () => {
    // System and the first assistant both point at the model span; matching
    // on span id alone used to jump the selection to system on every poll.
    let state = applyLoadedTrace(
      createTraceViewerState(),
      trace([
        span({ name: "agent.turn", spanId: "a".repeat(16) }),
        span({ name: "agent.step", spanId: "b".repeat(16), parentSpanId: "a".repeat(16) }),
        span({
          name: "ai.streamText.doStream",
          spanId: "c".repeat(16),
          parentSpanId: "b".repeat(16),
          attributes: {
            "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
            "ai.prompt.system": "system prompt",
            "ai.response.text": "reply",
          },
        }),
      ]),
    );
    expect(state.conversationItems.map((item) => item.kind)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    state = reduceTraceViewerKey(state, key("down"), ENV).state;
    state = reduceTraceViewerKey(state, key("down"), ENV).state;
    expect(state.selectedRow).toBe(2);
    // Simulate a poll: the selection must stay on the assistant card.
    state = applyLoadedTrace(state, state.trace!);
    expect(state.selectedRow).toBe(2);
    expect(state.conversationItems[state.selectedRow]?.kind).toBe("assistant");
  });

  it("clears the view with a notice when the trace is pruned", () => {
    let state = applyLoadedTrace(createTraceViewerState(), conversationTrace());
    state = applyLoadedTrace(state, undefined);
    expect(state.conversationItems).toEqual([]);
    expect(state.notice).toContain("pruned");
  });
});
