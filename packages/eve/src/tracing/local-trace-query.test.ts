import { describe, expect, it } from "vitest";

import { queryLocalTraceSummaries } from "./local-trace-query.js";
import { summarizeLocalTrace, type LocalTraceSummary } from "./local-trace-summary.js";

const trace = (input: Partial<LocalTraceSummary>): LocalTraceSummary => ({
  ...summarizeLocalTrace("a".repeat(32), []),
  ...input,
});

describe("queryLocalTraceSummaries", () => {
  it("filters structural metadata before ranking and limiting results", () => {
    const result = queryLocalTraceSummaries(
      [
        trace({
          agentNames: ["worker"],
          errorSpanCount: 1,
          inputTokens: 50,
          sessionIds: ["session"],
          toolNames: ["read"],
          traceId: "b".repeat(32),
        }),
        trace({
          agentNames: ["worker"],
          errorSpanCount: 2,
          inputTokens: 100,
          sessionIds: ["session"],
          toolNames: ["read"],
          traceId: "a".repeat(32),
        }),
        trace({ agentNames: ["other"], errorSpanCount: 3, traceId: "c".repeat(32) }),
      ],
      {
        agentName: "worker",
        failedOnly: true,
        limit: 1,
        sessionId: "session",
        sortBy: "failures",
        toolName: "read",
      },
    );

    expect(result).toEqual({
      matches: [expect.objectContaining({ traceId: "a".repeat(32) })],
      truncated: true,
    });
  });

  it.each([
    ["duration", { durationMs: 10 }],
    ["failures", { errorSpanCount: 2 }],
    ["inputTokens", { inputTokens: 100 }],
    ["latest", { startedAt: "2026-01-01T00:00:00.000Z" }],
  ] as const)("ranks %s descending without mutating summaries", (sortBy, fields) => {
    const older = trace({ traceId: "a".repeat(32) });
    const higher = trace({ traceId: "b".repeat(32), ...fields });
    const summaries = [older, higher];
    expect(queryLocalTraceSummaries(summaries, { limit: 2, sortBy })).toEqual({
      matches: [higher, older],
      truncated: false,
    });
    expect(summaries).toEqual([older, higher]);
  });

  it("filters for error spans, including traces that recovered", () => {
    const healthy = trace({ traceId: "a".repeat(32) });
    const recovered = trace({ traceId: "b".repeat(32), errorSpanCount: 1 });
    expect(
      queryLocalTraceSummaries([healthy, recovered], {
        failedOnly: true,
        limit: 2,
        sortBy: "latest",
      }),
    ).toEqual({ matches: [recovered], truncated: false });
  });

  it("uses trace id as a deterministic ranking tie-breaker", () => {
    const result = queryLocalTraceSummaries(
      [trace({ traceId: "b".repeat(32) }), trace({ traceId: "a".repeat(32) })],
      { limit: 2, sortBy: "duration" },
    );

    expect(result.matches.map(({ traceId }) => traceId)).toEqual(["a".repeat(32), "b".repeat(32)]);
  });
});
