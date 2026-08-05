import { describe, expect, it } from "vitest";

import { parseLocalTraceSegment } from "./local-trace-reader.js";

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "a".repeat(16);

function segment(spans: Record<string, unknown>[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          { scope: { name: "eve.agent" }, spans: spans.map((s) => ({ ...s, traceId: TRACE_ID })) },
        ],
      },
    ],
  });
}

function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attributes: [],
    endTimeUnixNano: "20000000",
    name: "agent.step",
    spanId: SPAN_ID,
    startTimeUnixNano: "10000000",
    status: { code: 0 },
    ...overrides,
  };
}

describe("parseLocalTraceSegment", () => {
  it("parses span events with attributes, sorted by time", () => {
    const spans = parseLocalTraceSegment(
      segment([
        span({
          events: [
            {
              attributes: [{ key: "step.index", value: { intValue: 2 } }],
              name: "step.completed",
              timeUnixNano: "19000000",
            },
            { name: "step.started", timeUnixNano: "11000000" },
          ],
        }),
      ]),
      TRACE_ID,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.events).toEqual([
      { attributes: {}, name: "step.started", timeNs: 11_000_000n },
      { attributes: { "step.index": 2 }, name: "step.completed", timeNs: 19_000_000n },
    ]);
  });

  it("skips malformed events while keeping valid ones", () => {
    const spans = parseLocalTraceSegment(
      segment([
        span({
          events: [
            { name: "step.started", timeUnixNano: "11000000" },
            { timeUnixNano: "12000000" },
            { name: "step.failed" },
            "not an event",
            { name: "step.completed", timeUnixNano: "18446744073709551616" },
          ],
        }),
      ]),
      TRACE_ID,
    );

    expect(spans[0]!.events).toEqual([
      { attributes: {}, name: "step.started", timeNs: 11_000_000n },
    ]);
  });

  it("parses status message and span kind", () => {
    const spans = parseLocalTraceSegment(
      segment([
        span({
          kind: 2,
          status: { code: 2, message: "model call failed" },
        }),
      ]),
      TRACE_ID,
    );

    expect(spans[0]!.statusCode).toBe(2);
    expect(spans[0]!.statusMessage).toBe("model call failed");
    expect(spans[0]!.kind).toBe(2);
  });

  it("defaults to no events, status message, or kind", () => {
    const spans = parseLocalTraceSegment(segment([span()]), TRACE_ID);

    expect(spans[0]!.events).toEqual([]);
    expect(spans[0]!.statusMessage).toBeUndefined();
    expect(spans[0]!.kind).toBeUndefined();
  });

  it("drops empty status messages", () => {
    const spans = parseLocalTraceSegment(
      segment([span({ status: { code: 1, message: "" } })]),
      TRACE_ID,
    );

    expect(spans[0]!.statusMessage).toBeUndefined();
  });
});
