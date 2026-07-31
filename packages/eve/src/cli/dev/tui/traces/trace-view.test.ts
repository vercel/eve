import { describe, expect, it } from "vitest";

import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";

import { createTheme } from "../theme.js";
import {
  conversationSelectionText,
  panelSelectionText,
  renderSpanDetail,
  renderTraceViewer,
} from "./trace-view.js";
import type { TraceViewerState } from "./trace-viewer-state.js";
import { applyLoadedTrace, applyTraceList, createTraceViewerState } from "./trace-viewer-state.js";

const THEME = createTheme({ color: true, unicode: true });
const NO_COLOR_THEME = createTheme({ color: false, unicode: true });
const BASE = 1_700_000_000_000_000_000n;

function span(
  spanId: string,
  name: string,
  startMs: number,
  endMs: number,
  parentSpanId?: string,
  attributes: Readonly<Record<string, unknown>> = {},
  statusCode = 0,
): LocalTraceSpan {
  return {
    attributes,
    endTimeNs: BASE + BigInt(endMs) * 1_000_000n,
    name,
    parentSpanId,
    spanId,
    startTimeNs: BASE + BigInt(startMs) * 1_000_000n,
    statusCode,
    traceId: "t".repeat(32),
  };
}

/** A turn with a user message, an assistant reply, and a tool call. */
function conversationSpans(): LocalTraceSpan[] {
  const turn = span("a".repeat(16), "agent.turn", 0, 0, undefined, { "agent.turn.id": "turn_0" });
  const step = span("b".repeat(16), "agent.step", 10, 5000, turn.spanId, {});
  const model = span("c".repeat(16), "ai.streamText.doStream", 20, 2000, step.spanId, {
    "gen_ai.request.model": "gpt-5",
    "agent.usage.input_tokens": 1234,
    "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    "ai.prompt.system": "You are a test assistant.",
    "ai.response.text": "reply",
  });
  const action = span("d".repeat(16), "agent.action", 2100, 2400, step.spanId, {});
  const toolCall = span("e".repeat(16), "ai.toolCall", 2100, 2400, action.spanId, {
    "gen_ai.tool.name": "get_weather",
    "gen_ai.tool.call.arguments": '{"city":"sf"}',
  });
  return [turn, step, model, action, toolCall];
}

function viewerState(
  spans: readonly LocalTraceSpan[],
  overrides: Partial<TraceViewerState> = {},
): TraceViewerState {
  const traceId = "t".repeat(32);
  const starts = spans.map((s) => s.startTimeNs);
  const ends = spans.map((s) => s.endTimeNs);
  const trace: LocalTrace = {
    agentName: "weather",
    endTimeNs: ends.reduce((a, b) => (b > a ? b : a), 0n),
    sessionId: "session-123",
    sessionIds: ["session-123"],
    spans,
    startTimeNs: starts.reduce((a, b) => (b < a ? b : a), starts[0] ?? 0n),
    traceId,
  };
  let state = applyTraceList(createTraceViewerState(), [{ traceId, lastActivityMs: Date.now() }]);
  state = applyLoadedTrace(state, trace);
  return { ...state, ...overrides };
}

function render(state: TraceViewerState, width = 100, height = 30) {
  return renderTraceViewer(state, { width, height, theme: THEME });
}

function clockTimeOf(nanoseconds: bigint): string {
  const date = new Date(Number(nanoseconds / 1_000_000n));
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

describe("renderTraceViewer", () => {
  it("renders the header with full session id, start time, counts, and position", () => {
    const frame = render(viewerState(conversationSpans()));
    const header = stripAnsi(frame.rows[1]!);
    expect(header).toContain("traces");
    expect(header).toContain("weather");
    expect(header).toContain("session session-123");
    expect(header).toContain(clockTimeOf(BASE));
    expect(header).toContain("5 spans");
    expect(header).toContain("[1/1]");
  });

  it("renders the conversation cards, selecting the first card", () => {
    const frame = render(viewerState(conversationSpans()));
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).toContain("system");
    expect(body).toContain("user");
    expect(body).toContain("assistant");
    expect(body).toContain("reply");
    expect(body).toContain("get_weather");
    // First card (system) is selected: white half-block bar on its rows.
    const selectedRows = frame.rows.filter((row) => row.includes("\x1b[97m▌"));
    expect(selectedRows.length).toBeGreaterThan(0);
  });

  it("shows the copy toast as a floating card below the title", () => {
    const state = viewerState(conversationSpans());
    const frame = renderTraceViewer(state, {
      width: 100,
      height: 30,
      theme: THEME,
      toast: "Copied to clipboard",
    });
    // Message row with the left bar, padding rows above and below.
    expect(stripAnsi(frame.rows[3]!)).toContain("▌  Copied to clipboard");
    expect(stripAnsi(frame.rows[2]!)).toMatch(/▌ +$/u);
    expect(stripAnsi(frame.rows[4]!)).toMatch(/▌ +$/u);
    expect(stripAnsi(frame.rows[1]!)).not.toContain("Copied");
  });

  it("paints an active drag selection in reverse video", () => {
    const state = viewerState(conversationSpans(), {
      textSelection: {
        anchor: { line: 1, column: 2 },
        head: { line: 2, column: 10 },
        dragging: true,
        region: "conversation" as const,
      },
    });
    const frame = render(state);
    const highlighted = frame.rows.filter((row) => row.includes("\x1b[7m"));
    expect(highlighted.length).toBe(2);
  });

  it("extracts the dragged text from the rendered conversation", () => {
    const state = viewerState(conversationSpans());
    // The system card's title row is line 1 ("  ▸ system" once rendered).
    const selection = {
      anchor: { line: 1, column: 0 },
      head: { line: 1, column: 40 },
      dragging: true,
      region: "conversation" as const,
    };
    const text = conversationSelectionText(state, 100, THEME, selection);
    expect(text).toContain("system");
    expect(text).not.toContain("\x1b");
    // A multi-line drag keeps line structure.
    const multi = conversationSelectionText(state, 100, THEME, {
      anchor: { line: 1, column: 0 },
      head: { line: 5, column: 99 },
      dragging: true,
      region: "conversation" as const,
    });
    expect(multi.split("\n").length).toBe(5);
  });

  it("paints a drawer drag selection on the panel, not the cards", () => {
    const state = viewerState(conversationSpans(), {
      panelOpen: true,
      textSelection: {
        anchor: { line: 1, column: 0 },
        head: { line: 3, column: 10 },
        dragging: true,
        region: "panel" as const,
      },
    });
    const frame = render(state);
    const highlighted = frame.rows.filter((row) => row.includes("\x1b[7m"));
    expect(highlighted.length).toBe(3);
    // The highlight sits in the drawer area (right of the conversation).
    for (const row of highlighted) {
      const before = row.slice(0, row.indexOf("\x1b[7m"));
      expect(visibleLength(before)).toBeGreaterThanOrEqual(frame.contentWidth);
    }
  });

  it("extracts the dragged text from the details drawer", () => {
    const state = viewerState(conversationSpans(), { panelOpen: true });
    // Detail line 1 is the selected span's name (line 0 is top padding).
    const text = panelSelectionText(state, 100, THEME, {
      anchor: { line: 1, column: 0 },
      head: { line: 2, column: 40 },
      dragging: true,
      region: "panel" as const,
    });
    expect(text).toContain("ai.streamText.doStream");
    expect(text).not.toContain("\x1b");
    expect(text.split("\n").length).toBe(2);
  });

  it("marks error cards and shows the error status in the detail panel", () => {
    const turn = span("a".repeat(16), "agent.turn", 0, 0);
    const step = span("b".repeat(16), "agent.step", 10, 300, turn.spanId, {});
    const model = span("c".repeat(16), "ai.streamText.doStream", 20, 100, step.spanId, {
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
      "ai.response.text": "reply",
      "agent.usage.input_tokens": 10,
    });
    const action = span("d".repeat(16), "agent.action", 110, 200, step.spanId, {});
    const failingToolCall = {
      ...span("f".repeat(16), "ai.toolCall", 110, 200, action.spanId, {
        "gen_ai.tool.name": "explode",
      }),
      statusCode: 2,
    };
    const frame = render(
      viewerState([turn, step, model, action, failingToolCall], {
        panelOpen: true,
        selectedRow: 2,
      }),
    );
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).toContain("explode");
    expect(frame.rows.some((row) => row.includes("\x1b[48;2;69;32;37m"))).toBe(true);
  });

  it("opens the details drawer on the right with the selected card's attributes", () => {
    const frame = render(viewerState(conversationSpans(), { panelOpen: true, selectedRow: 2 }));
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).toContain("gen_ai.request.model gpt-5");
    expect(body).toContain("agent.usage.input_tokens 1234");
    expect(frame.panelTotalRows).toBeGreaterThan(3);
    // No rule divider between cards and drawer — padded space only.
    expect(frame.rows.some((row) => row.includes("│ gen_ai"))).toBe(false);
  });

  it("skips payload keys in the drawer since the cards already carry them", () => {
    const frame = render(viewerState(conversationSpans(), { panelOpen: true, selectedRow: 2 }));
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).not.toContain("ai.prompt.messages");
    expect(body).not.toContain("ai.response.text");
    expect(body).toContain("agent.usage.input_tokens 1234");
  });

  it("scrolls the drawer by slicing detail lines with panelScroll", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`key.${index}`, `value-${index}`]),
    );
    const turn = span("a".repeat(16), "agent.turn", 0, 0);
    const action = span("d".repeat(16), "agent.action", 100, 200, turn.spanId, {});
    const toolCall = span("f".repeat(16), "ai.toolCall", 100, 200, action.spanId, attributes);
    const state = viewerState([turn, action, toolCall], {
      panelOpen: true,
      selectedRow: 0,
      panelScroll: 15,
    });
    const frame = render(state);
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).toContain("key.15 value-15");
    expect(body).not.toContain("key.0 value-0");
  });

  it("renders the empty state and the EVE_TRACES=off copy", () => {
    const empty = createTraceViewerState();
    expect(stripAnsi(render(empty).rows.join("\n"))).toContain("No local traces yet.");
    const disabled = renderTraceViewer(empty, {
      width: 100,
      height: 30,
      theme: THEME,
      tracingDisabled: true,
    });
    expect(stripAnsi(disabled.rows.join("\n"))).toContain("EVE_TRACES=off");
  });

  it("shows the footer hints and the card position", () => {
    const frame = render(viewerState(conversationSpans()));
    const footer = frame.rows.map(stripAnsi).slice(-2).join("\n");
    expect(footer).toContain("select");
    expect(footer).toContain("expand");
    expect(footer).toContain("q close");
    expect(footer).toContain("item 1/");
    expect(footer).not.toContain(" v ");
  });

  it("never emits rows wider than the terminal", () => {
    for (const width of [40, 60, 80, 120]) {
      const frame = render(viewerState(conversationSpans(), { panelOpen: true }), width, 24);
      for (const row of frame.rows) {
        expect(visibleLength(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("never emits a raw newline inside a frame row, even from \n-laden payloads", () => {
    // A tool result ending in a real newline used to split its composed row
    // and inject a phantom blank line into the frame.
    const turn = span("a".repeat(16), "agent.turn", 0, 0);
    const selected = span("f".repeat(16), "ai.toolCall", 100, 200, turn.spanId, {
      "gen_ai.tool.call.result": "When the user asks about weather, call the tool.\n",
      "gen_ai.tool.name": "load_skill",
    });
    const frame = render(viewerState([turn, selected], { panelOpen: true }), 100, 24);
    for (const row of frame.rows) {
      expect(row).not.toContain("\n");
      expect(row).not.toContain("\r");
    }
    const body = frame.rows.map(stripAnsi).join("\n");
    expect(body).toContain("call the");
  });

  it("reports viewport metrics for key handling", () => {
    // 30 rows minus three header rows (padding, title, padding) and the three-row
    // footer (padding + hints + status).
    const frame = render(viewerState(conversationSpans()), 100, 30);
    expect(frame.timelineViewportRows).toBe(24);
    expect(frame.panelViewportRows).toBe(24);
    expect(frame.panelTotalRows).toBe(0);
  });

  it("paints every frame row on the viewer's base canvas at full width", () => {
    const frame = render(viewerState(conversationSpans()), 100, 30);
    for (const row of frame.rows) {
      expect(row).toContain("\x1b[48;2;0;0;0m");
      expect(visibleLength(row)).toBe(100);
    }
    const plain = renderTraceViewer(viewerState(conversationSpans()), {
      width: 100,
      height: 30,
      theme: NO_COLOR_THEME,
    });
    for (const row of plain.rows) expect(row).not.toContain("\x1b[48;2;");
  });
});

describe("renderSpanDetail", () => {
  it("renders facts and a sorted attributes table", () => {
    const detail = renderSpanDetail(
      span("f".repeat(16), "agent.action", 100, 200, "b".repeat(16), {
        "z.key": "last",
        "a.key": "first",
      }),
      40,
      NO_COLOR_THEME,
    );
    const text = detail.join("\n");
    expect(text).toContain("agent.action");
    expect(text).toContain("status");
    expect(text).toContain("ok");
    expect(text).toContain("duration");
    expect(text).toContain("parent");
    expect(text.indexOf("a.key first")).toBeLessThan(text.indexOf("z.key last"));
  });

  it("wraps long values to the panel width", () => {
    const detail = renderSpanDetail(
      span("f".repeat(16), "span", 100, 200, undefined, { "long.value": "x".repeat(200) }),
      30,
      NO_COLOR_THEME,
    );
    for (const line of detail) {
      expect(visibleLength(line)).toBeLessThanOrEqual(30);
    }
    expect(detail.length).toBeGreaterThan(8);
  });
});
