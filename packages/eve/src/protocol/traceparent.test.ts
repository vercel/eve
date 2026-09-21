import { describe, expect, it } from "vitest";

import {
  formatTraceparent,
  parseTraceparent,
  readAgentDispatchTraceContext,
  writeAgentDispatchTracestate,
} from "#protocol/traceparent.js";

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "2".repeat(16);

describe("traceparent", () => {
  it("round-trips a remote sampled context", () => {
    const header = formatTraceparent({ spanId: SPAN_ID, traceFlags: 1, traceId: TRACE_ID });
    expect(header).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(parseTraceparent(header!)).toEqual({
      isRemote: true,
      spanId: SPAN_ID,
      traceFlags: 1,
      traceId: TRACE_ID,
    });
  });

  it.each([
    null,
    "",
    `01-${TRACE_ID}-${SPAN_ID}-01`,
    `00-${"0".repeat(32)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `00-${TRACE_ID}-${SPAN_ID}-0g`,
    `00-${TRACE_ID}-${SPAN_ID}-01,00-${TRACE_ID}-${SPAN_ID}-01`,
  ])("ignores malformed input %p", (value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it("omits invalid outbound contexts", () => {
    expect(
      formatTraceparent({ spanId: "0".repeat(16), traceFlags: 1, traceId: TRACE_ID }),
    ).toBeUndefined();
    expect(
      formatTraceparent({ spanId: SPAN_ID, traceFlags: 256, traceId: TRACE_ID }),
    ).toBeUndefined();
  });
});

describe("agent dispatch tracestate", () => {
  const transport = {
    isRemote: true,
    spanId: "3".repeat(16),
    traceFlags: 1,
    traceId: TRACE_ID,
  } as const;

  it("preserves and restores the prior eve parent", () => {
    const value = writeAgentDispatchTracestate("vendor=opaque", {
      spanId: SPAN_ID,
      traceFlags: 1,
      traceId: TRACE_ID,
    });
    expect(value).toBe(`eve=${SPAN_ID},vendor=opaque`);
    expect(readAgentDispatchTraceContext(value!, transport)).toEqual({
      ...transport,
      spanId: SPAN_ID,
    });
  });

  it("removes authored eve state without a valid caller", () => {
    expect(writeAgentDispatchTracestate(`eve=${SPAN_ID},vendor=opaque`, undefined)).toBe(
      "vendor=opaque",
    );
  });

  it.each([null, "vendor=opaque", "eve=malformed", "eve=0000000000000000"])(
    "ignores unusable state %p",
    (value) => {
      expect(readAgentDispatchTraceContext(value, transport)).toBeUndefined();
    },
  );
  it("requires the transport trace identity", () => {
    expect(readAgentDispatchTraceContext(`eve=${SPAN_ID}`, undefined)).toBeUndefined();
  });

  it("evicts the least-recent member to retain W3C entry limits", () => {
    const value = writeAgentDispatchTracestate(
      Array.from({ length: 32 }, (_, index) => `v${index}=a`).join(","),
      { spanId: SPAN_ID, traceFlags: 1, traceId: TRACE_ID },
    )!;
    expect(value.split(",")).toHaveLength(32);
    expect(value.startsWith(`eve=${SPAN_ID},v0=a`)).toBe(true);
    expect(value).not.toContain("v31=a");
  });

  it("evicts the least-recent member to retain the W3C length limit", () => {
    const value = writeAgentDispatchTracestate(
      Array.from({ length: 20 }, (_, index) => `v${index}=${"a".repeat(21)}`).join(","),
      { spanId: SPAN_ID, traceFlags: 1, traceId: TRACE_ID },
    )!;
    expect(value.length).toBeLessThanOrEqual(512);
    expect(value.startsWith(`eve=${SPAN_ID},v0=`)).toBe(true);
    expect(value).not.toContain("v19=");
  });
});
