import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Datadog, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";

const datadogMocks = vi.hoisted(() => ({
  close: vi.fn(),
  init: vi.fn(),
  startExperiment: vi.fn(),
  submitEvaluationMetrics: vi.fn(),
  submitSpan: vi.fn(),
  url: vi.fn(),
}));

vi.mock("dd-trace", () => ({
  default: {
    init: datadogMocks.init,
    llmobs: {
      experiments: {
        startExperiment: datadogMocks.startExperiment,
      },
    },
  },
}));

const DATADOG_SPAN = {
  experimentId: "experiment-1",
  spanId: "span-1",
  traceId: "trace-1",
  url: "https://app.datadoghq.com/llm/experiments/experiment-1",
};

function makeTarget(): EveEvalTarget {
  return {
    capabilities: { devRoutes: true },
    kind: "local",
    url: "http://127.0.0.1:3000",
  };
}

function makeEval(): EveEval {
  return {
    _tag: "EveEval",
    description: "Answer the weather question.",
    id: "weather/forecast",
    metadata: { suite: "weather" },
    tags: ["smoke", "weather"],
    test: async () => {},
  };
}

function makeResult(overrides: Partial<EveEvalResult> = {}): EveEvalResult {
  return {
    id: "weather/forecast",
    result: {
      output: { answer: "sunny" },
      finalMessage: "sunny",
      status: "completed",
      events: [],
      derived: {
        toolCalls: [
          {
            name: "weather",
            input: { city: "Tokyo" },
            output: { condition: "sunny" },
            status: "completed",
            turnIndex: 0,
            sessionId: "session-1",
          },
        ],
        toolCallCount: 1,
        subagentCalls: [],
        subagentCallCount: 0,
        inputRequests: [],
        parked: false,
        messageCount: 2,
        reasoningBlockCount: 0,
      },
      sessionId: "session-1",
      traceContexts: [
        {
          primary: true,
          sessionId: "session-1",
          spanId: "2".repeat(16),
          traceFlags: 1,
          traceId: "1".repeat(32),
        },
      ],
    },
    assertions: [
      { name: "succeeded", passed: true, score: 1, severity: "gate" },
      {
        name: "judge.autoevals.quality",
        passed: true,
        score: 0.8,
        severity: "soft",
        threshold: 0.7,
      },
      {
        name: "judge.autoevals.quality",
        passed: false,
        score: 0.4,
        severity: "soft",
        threshold: 0.7,
      },
    ],
    verdict: "scored",
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
    ...overrides,
  };
}

function makeSummary(): EveEvalRunSummary {
  return {
    target: makeTarget(),
    results: [makeResult()],
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
    passed: 0,
    failed: 0,
    scored: 1,
    skipped: 0,
    errored: 0,
  };
}

async function startReporter(config: DatadogReporterConfig = {}) {
  const reporter = Datadog(config);
  const evaluation = makeEval();
  const target = makeTarget();
  await reporter.onRunStart([evaluation], target);
  return { evaluation, reporter, target };
}

describe("Datadog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DD_API_KEY", "api-key");
    vi.stubEnv("DD_APP_KEY", "app-key");
    datadogMocks.startExperiment.mockResolvedValue({
      close: datadogMocks.close,
      submitEvaluationMetrics: datadogMocks.submitEvaluationMetrics,
      submitSpan: datadogMocks.submitSpan,
      url: datadogMocks.url,
    });
    datadogMocks.submitSpan.mockResolvedValue(DATADOG_SPAN);
    datadogMocks.url.mockReturnValue(DATADOG_SPAN.url);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts one external experiment with eval metadata", async () => {
    await startReporter({
      description: "Weather agent evals",
      experimentConfig: { model: "mock/weather" },
      experimentName: "weather regression",
      metadata: { owner: "agents" },
      projectName: "weather-agent",
      tags: { team: "agents" },
    });

    expect(datadogMocks.init).toHaveBeenCalledWith({
      llmobs: { agentlessEnabled: true, mlApp: "weather-agent" },
    });
    expect(datadogMocks.startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { model: "mock/weather" },
        description: "Weather agent evals",
        name: "weather regression",
        projectName: "weather-agent",
        metadata: expect.objectContaining({
          owner: "agents",
          "eve.eval.names": ["weather/forecast"],
          "eve.target.kind": "local",
        }),
        tags: {
          team: "agents",
          "eve.framework": "eve",
          "eve.target.kind": "local",
        },
      }),
    );
  });

  it("submits eval output, trace correlation, and sanitized evaluation metrics", async () => {
    const { reporter } = await startReporter();
    const result = makeResult();

    await reporter.onEvalComplete(result);

    expect(datadogMocks.submitSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "weather/forecast",
        input: "Answer the weather question.",
        output: { answer: "sunny" },
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:01.000Z",
        metadata: expect.objectContaining({
          suite: "weather",
          eveFailedAssertions: [
            {
              name: "judge.autoevals.quality",
              passed: false,
              score: 0.4,
              severity: "soft",
              threshold: 0.7,
            },
          ],
          eveParked: false,
          eveSessionId: "session-1",
          eveStatus: "completed",
          eveSubagentCalls: [],
          eveTraceContexts: result.result.traceContexts,
          eveTraceIds: ["1".repeat(32)],
          eveToolCalls: ["weather"],
          eveVerdict: "scored",
        }),
        tags: {
          "eve.verdict": "scored",
        },
      }),
    );

    const submittedInput = datadogMocks.submitSpan.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submittedInput).not.toHaveProperty("spanId");
    expect(submittedInput).not.toHaveProperty("traceId");
    expect(datadogMocks.submitEvaluationMetrics).toHaveBeenCalledWith(DATADOG_SPAN, [
      { label: "eve_verdict", source: "eve", value: "scored" },
      {
        label: "gate_succeeded",
        source: "eve",
        value: 1,
        tags: {
          "eve.assertion.name": "succeeded",
          "eve.assertion.passed": "true",
          "eve.assertion.severity": "gate",
        },
      },
      {
        label: "judge_autoevals_quality",
        source: "eve",
        value: 0.8,
        tags: {
          "eve.assertion.name": "judge.autoevals.quality",
          "eve.assertion.passed": "true",
          "eve.assertion.severity": "soft",
          "eve.assertion.threshold": "0.7",
        },
      },
      {
        label: "judge_autoevals_quality_2",
        source: "eve",
        value: 0.4,
        tags: {
          "eve.assertion.name": "judge.autoevals.quality",
          "eve.assertion.passed": "false",
          "eve.assertion.severity": "soft",
          "eve.assertion.threshold": "0.7",
        },
      },
    ]);
  });

  it("reports evals without inventing runtime trace metadata", async () => {
    const { reporter } = await startReporter();
    await reporter.onEvalComplete(
      makeResult({
        result: {
          ...makeResult().result,
          traceContexts: [],
        },
      }),
    );

    const submitted = datadogMocks.submitSpan.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(submitted.metadata).not.toHaveProperty("eveTraceContexts");
    expect(submitted.metadata).not.toHaveProperty("eveTraceIds");
  });

  it("closes the external experiment and prints its URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reporter } = await startReporter();

    await reporter.onRunComplete(makeSummary());

    expect(datadogMocks.close).toHaveBeenCalledWith({ status: "completed" });
    expect(log).toHaveBeenCalledWith(`Datadog experiment: ${DATADOG_SPAN.url}\n\n`);
    log.mockRestore();
  });

  it("requires Datadog API and application keys", async () => {
    vi.stubEnv("DD_API_KEY", "");
    vi.stubEnv("DD_APP_KEY", "");

    await expect(Datadog().onRunStart([makeEval()], makeTarget())).rejects.toThrow(
      "Datadog reporting requires DD_API_KEY and DD_APP_KEY",
    );
  });
});
