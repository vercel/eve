import { beforeEach, describe, expect, it, vi } from "vitest";
import { Braintrust, type BraintrustReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalTarget } from "#evals/types.js";

const braintrustMocks = vi.hoisted(() => ({
  close: vi.fn(),
  flush: vi.fn(),
  init: vi.fn(),
  log: vi.fn(),
  summarize: vi.fn(),
}));

vi.mock("braintrust", () => ({
  flush: braintrustMocks.flush,
  init: braintrustMocks.init,
}));

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
            status: "completed",
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
      { name: "succeeded", score: 1, severity: "gate", passed: true },
      { name: "similarity", score: 1, severity: "soft", threshold: 0.6, passed: true },
    ],
    verdict: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function makeEval(): EveEval {
  return {
    _tag: "EveEval",
    id: "eval-1",
    test: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Braintrust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    braintrustMocks.init.mockResolvedValue({
      close: braintrustMocks.close,
      log: braintrustMocks.log,
      summarize: braintrustMocks.summarize,
    });
  });

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
      skipped: 0,
      errored: 0,
    });
  });

  it("uploads complete failed assertion diagnostics", async () => {
    const reporter = Braintrust(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      makeEvalResult({
        assertions: [
          {
            message: 'prompt: "Name the source."',
            metadata: {
              criteria: "cites a source",
              input: "Name the source.",
              rationale: "No source was cited.",
            },
            name: "judge.autoevals.closedQA",
            passed: false,
            score: 0,
            severity: "soft",
            threshold: 0.8,
          },
        ],
        verdict: "scored",
      }),
    );

    expect(braintrustMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          eveFailedAssertions: [
            {
              message: 'prompt: "Name the source."',
              metadata: {
                criteria: "cites a source",
                input: "Name the source.",
                rationale: "No source was cited.",
              },
              name: "judge.autoevals.closedQA",
              passed: false,
              score: 0,
              severity: "soft",
              threshold: 0.8,
            },
          ],
        }),
      }),
    );
  });

  it("logs an empty output instead of null when the eval produced no agent turn", async () => {
    const reporter = Braintrust(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      makeEvalResult({
        result: { ...makeEvalResult().result, output: null },
      }),
    );

    expect(braintrustMocks.log).toHaveBeenCalledWith(expect.objectContaining({ output: "" }));
  });

  it("keeps duplicate assertion scores under stable keys", async () => {
    const reporter = Braintrust(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      makeEvalResult({
        assertions: [
          { name: "similarity", passed: true, score: 0.8, severity: "soft" },
          { name: "similarity", passed: true, score: 0.6, severity: "soft" },
        ],
      }),
    );

    expect(braintrustMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        scores: {
          similarity: 0.8,
          "similarity#2": 0.6,
        },
      }),
    );
  });
});
