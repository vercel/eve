import { describe, expect, it, vi } from "vitest";

import type { LocalTrace, LocalTraceSpan } from "#tracing/local-trace-reader.js";

import { createTheme } from "../theme.js";
import type { TraceStore } from "./trace-store.js";
import { TraceViewerSession } from "./trace-viewer-session.js";

const THEME = createTheme({ color: false, unicode: true });

function span(spanId: string, sessionId: string): LocalTraceSpan {
  return {
    attributes: {
      "agent.name": "tester",
      "agent.session.id": sessionId,
      "agent.turn.id": "turn_0",
    },
    endTimeNs: 1_000_000n,
    name: "agent.turn",
    spanId,
    startTimeNs: 1_000_000n,
    statusCode: 0,
    traceId: "unused",
  };
}

function trace(traceId: string, sessionIds: readonly string[]): LocalTrace {
  const spans = sessionIds.map((sessionId, index) =>
    span(String(index).padStart(16, "0"), sessionId),
  );
  return {
    endTimeNs: 1_000_000n,
    sessionId: sessionIds[0],
    sessionIds,
    spans,
    startTimeNs: 1_000_000n,
    traceId,
  };
}

function stubStore(traces: readonly LocalTrace[]): TraceStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async list() {
      // Newest activity first, mirroring the real store's ordering.
      return traces.map((entry, index) => ({
        traceId: entry.traceId,
        lastActivityMs: traces.length - index,
      }));
    },
    async read(traceId) {
      reads.push(traceId);
      return traces.find((entry) => entry.traceId === traceId);
    },
  };
}

async function openViewer(store: TraceStore, sessionId?: string) {
  const frames: string[][] = [];
  const session = new TraceViewerSession({
    appRoot: "/nowhere",
    dimensions: () => ({ width: 80, height: 24 }),
    paint: (rows) => frames.push([...rows]),
    sessionId,
    store,
    theme: THEME,
  });
  session.start();
  await vi.waitFor(() => {
    const last = frames[frames.length - 1]?.join("\n") ?? "";
    if (!last.includes("session")) throw new Error("no trace frame yet");
  });
  session.dispose();
  return frames[frames.length - 1]!.join("\n");
}

describe("TraceViewerSession drag copy", () => {
  it("copies the dragged text and shows a toast", async () => {
    const turn = span("a".repeat(16), "session-mine");
    const model: LocalTraceSpan = {
      ...span("b".repeat(16), "session-mine"),
      name: "ai.streamText.doStream",
      parentSpanId: turn.spanId,
      attributes: {
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "copy me please" }]),
        "ai.response.text": "reply",
      },
    };
    const store = stubStore([
      {
        endTimeNs: 1_000_000n,
        sessionId: "session-mine",
        sessionIds: ["session-mine"],
        spans: [turn, model],
        startTimeNs: 1_000_000n,
        traceId: "c".repeat(32),
      },
    ]);
    const frames: string[][] = [];
    const copied: string[] = [];
    const session = new TraceViewerSession({
      appRoot: "/nowhere",
      copyText: (text) => copied.push(text),
      dimensions: () => ({ width: 80, height: 24 }),
      paint: (rows) => frames.push([...rows]),
      store,
      theme: THEME,
    });
    session.start();
    await vi.waitFor(() => {
      const last = frames[frames.length - 1]?.join("\n") ?? "";
      if (!last.includes("copy me please")) throw new Error("no conversation frame yet");
    });
    // Drag across the user card's text row (three header rows, then the
    // card's band, title, band, and padding rows): press, motion, release.
    session.handleKey({ type: "mouse", action: "press", button: 0, x: 1, y: 8 });
    session.handleKey({ type: "mouse", action: "press", button: 32, x: 40, y: 8 });
    session.handleKey({ type: "mouse", action: "release", button: 0, x: 40, y: 8 });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("copy me please");
    expect(frames[frames.length - 1]!.join("\n")).toContain("Copied to clipboard");

    // A drag over the open drawer copies drawer text: at width 80 the
    // drawer starts right of the conversation's 46 columns, and detail
    // line 1 carries the selected span's name.
    session.handleKey({ type: "enter" });
    session.handleKey({ type: "mouse", action: "press", button: 0, x: 49, y: 5 });
    session.handleKey({ type: "mouse", action: "press", button: 32, x: 75, y: 5 });
    session.handleKey({ type: "mouse", action: "release", button: 0, x: 75, y: 5 });
    expect(copied).toHaveLength(2);
    expect(copied[1]).toContain("agent.turn");
    session.dispose();
  });
});

describe("TraceViewerSession background surfaces", () => {
  it("derives card bands from the OSC 11 background reply and repaints", async () => {
    const turn = span("a".repeat(16), "session-mine");
    const model: LocalTraceSpan = {
      ...span("b".repeat(16), "session-mine"),
      name: "ai.streamText.doStream",
      parentSpanId: turn.spanId,
      attributes: {
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
        "ai.response.text": "reply",
      },
    };
    const store = stubStore([
      {
        endTimeNs: 1_000_000n,
        sessionId: "session-mine",
        sessionIds: ["session-mine"],
        spans: [turn, model],
        startTimeNs: 1_000_000n,
        traceId: "c".repeat(32),
      },
    ]);
    const frames: string[][] = [];
    const session = new TraceViewerSession({
      appRoot: "/nowhere",
      dimensions: () => ({ width: 80, height: 24 }),
      paint: (rows) => frames.push([...rows]),
      store,
      theme: createTheme({ color: true, unicode: true }),
    });
    session.start();
    await vi.waitFor(() => {
      const last = frames[frames.length - 1]?.join("\n") ?? "";
      if (!last.includes("reply")) throw new Error("no conversation frame yet");
    });
    // Before the terminal answers the probe: rail rendering, no truecolor.
    expect(frames[frames.length - 1]!.join("\n")).not.toContain("\x1b[48;2;");
    session.setTerminalBackground({ r: 0, g: 0, b: 0 });
    const surfaced = frames[frames.length - 1]!.join("\n");
    expect(surfaced).toContain("\x1b[48;2;22;22;22m");
    expect(surfaced).toContain("\x1b[48;2;36;36;36m");
    session.dispose();
  });

  it("paints surfaces from the first conversation frame with a cached background", async () => {
    const turn = span("a".repeat(16), "session-mine");
    const model: LocalTraceSpan = {
      ...span("b".repeat(16), "session-mine"),
      name: "ai.streamText.doStream",
      parentSpanId: turn.spanId,
      attributes: {
        "ai.prompt.messages": JSON.stringify([{ role: "user", content: "hi" }]),
        "ai.response.text": "reply",
      },
    };
    const store = stubStore([
      {
        endTimeNs: 1_000_000n,
        sessionId: "session-mine",
        sessionIds: ["session-mine"],
        spans: [turn, model],
        startTimeNs: 1_000_000n,
        traceId: "c".repeat(32),
      },
    ]);
    const frames: string[][] = [];
    const session = new TraceViewerSession({
      appRoot: "/nowhere",
      dimensions: () => ({ width: 80, height: 24 }),
      paint: (rows) => frames.push([...rows]),
      store,
      terminalBackground: { r: 0, g: 0, b: 0 },
      theme: createTheme({ color: true, unicode: true }),
    });
    session.start();
    await vi.waitFor(() => {
      const last = frames[frames.length - 1]?.join("\n") ?? "";
      if (!last.includes("reply")) throw new Error("no conversation frame yet");
    });
    expect(frames[frames.length - 1]!.join("\n")).toContain("\x1b[48;2;22;22;22m");
    session.dispose();
  });
});

describe("TraceViewerSession session preference", () => {
  it("opens on the trace containing the current session, not the newest", async () => {
    // Trace ids are provider-generated, so the session's trace is found by
    // matching sessionIds — here the session lives in the older trace.
    const store = stubStore([
      trace("a".repeat(32), ["session-other"]),
      trace("b".repeat(32), ["session-mine"]),
    ]);
    const frame = await openViewer(store, "session-mine");
    expect(frame).toContain("session session-mine");
    expect(frame).toContain("[2/2]");
  });

  it("matches a subagent session to the parent trace it recorded into", async () => {
    const store = stubStore([
      trace("a".repeat(32), ["session-root", "session-child"]),
      trace("b".repeat(32), ["session-other"]),
    ]);
    const frame = await openViewer(store, "session-child");
    expect(frame).toContain("session session-root");
    expect(frame).toContain("[1/2]");
  });

  it("falls back to the newest trace when the session has no trace yet", async () => {
    const store = stubStore([
      trace("a".repeat(32), ["session-other"]),
      trace("b".repeat(32), ["session-older"]),
    ]);
    const frame = await openViewer(store, "session-unseen");
    expect(frame).toContain("session session-other");
    expect(frame).toContain("[1/2]");
  });
});
