import { describe, expect, it } from "vitest";

import { resolveRuntimeTraceLinks } from "#evals/runner/reporters/datadog-runtime-trace-links.js";
import type { EveEvalTraceContext } from "#evals/types.js";

function traceContext(overrides: Partial<EveEvalTraceContext> = {}): EveEvalTraceContext {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    traceFlags: 1,
    sessionId: "session-1",
    primary: true,
    ...overrides,
  };
}

describe("resolveRuntimeTraceLinks", () => {
  it("stores the Datadog-indexed IDs for a real W3C runtime context", () => {
    expect(
      resolveRuntimeTraceLinks([
        traceContext({
          traceId: "010280a6f337b4e3117b3db95c1ad3fe",
          spanId: "140edab97d7fb4ef",
          sessionId: "wrun_01M3533VV7F1M7FF5J8NQ3W7G8",
        }),
        traceContext({
          traceId: "fedcba9876543210fedcba9876543210",
          spanId: "fedcba9876543210",
          sessionId: "secondary",
          primary: false,
        }),
      ]),
    ).toEqual([
      {
        relation: "experiment_runtime",
        traceId: "e4eea2b9661c5e3890ed96de9715238e",
        spanId: "1445333020641834223",
        sessionId: "wrun_01M3533VV7F1M7FF5J8NQ3W7G8",
        primary: true,
      },
      {
        relation: "experiment_runtime",
        traceId: "d8464e48436c5124a7b8b5b463a20f61",
        spanId: "18364758544493064720",
        sessionId: "secondary",
        primary: false,
      },
    ]);
  });

  it("omits unsampled, malformed, and zero runtime contexts", () => {
    expect(
      resolveRuntimeTraceLinks([
        traceContext({ traceFlags: 0 }),
        traceContext({ traceId: "invalid", spanId: "invalid" }),
        traceContext({ traceId: "0".repeat(32) }),
        traceContext({ spanId: "0".repeat(16) }),
      ]),
    ).toEqual([]);
  });
});
