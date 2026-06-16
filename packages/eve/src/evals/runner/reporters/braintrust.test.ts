import { describe, expect, it } from "vitest";
import { Braintrust, type BraintrustReporterConfig } from "#evals/reporters/index.js";
import type { EveEvalResult, EveEvalTarget } from "#evals/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(kind: "local" | "remote" = "local"): EveEvalTarget {
  const url = kind === "local" ? "http://127.0.0.1:3000" : "https://test.vercel.app";
  return {
    capabilities: { devRoutes: kind === "local" },
    kind,
    url,
  };
}

function makeConfig(overrides: Partial<BraintrustReporterConfig> = {}): BraintrustReporterConfig {
  return {
    projectName: "test-project",
    ...overrides,
  };
}

function makeEvalResult(overrides: Partial<EveEvalResult> = {}): EveEvalResult {
  return {
    id: "eval-1",
    result: {
      output: "actual output",
      finalMessage: "actual output",
      status: "completed",
      events: [],
      derived: {
        toolCalls: [
          {
            name: "search",
            input: { query: "test" },
            output: null,
            isError: false,
            turnIndex: 0,
            sessionId: "session-123",
          },
        ],
        toolCallCount: 1,
        subagentCalls: [],
        subagentCallCount: 0,
        inputRequests: [],
        parked: false,
        messageCount: 1,
        reasoningBlockCount: 0,
      },
      sessionId: "session-123",
    },
    assertions: [
      { name: "completed", score: 1, severity: "gate", passed: true },
      { name: "similarity", score: 1, severity: "soft", threshold: 0.6, passed: true },
    ],
    verdict: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Braintrust", () => {
  it("creates a reporter", () => {
    const reporter = Braintrust(makeConfig());
    expect(reporter).toBeDefined();
    expect(reporter.onRunStart).toBeTypeOf("function");
    expect(reporter.onEvalComplete).toBeTypeOf("function");
    expect(reporter.onRunComplete).toBeTypeOf("function");
  });

  it("onEvalComplete is a no-op when experiment is not initialized", () => {
    const reporter = Braintrust(makeConfig());

    // Should not throw when called before onRunStart
    reporter.onEvalComplete(makeEvalResult());
  });

  it("onRunComplete is a no-op when experiment is not initialized", async () => {
    const reporter = Braintrust(makeConfig());

    // Should not throw when called before onRunStart
    await reporter.onRunComplete({
      target: makeTarget(),
      results: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      passed: 0,
      failed: 0,
      scored: 0,
      errored: 0,
    });
  });
});
