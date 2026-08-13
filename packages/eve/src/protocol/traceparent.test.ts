import { describe, expect, it } from "vitest";

import { formatTraceparent, parseTraceparent } from "#protocol/traceparent.js";

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
