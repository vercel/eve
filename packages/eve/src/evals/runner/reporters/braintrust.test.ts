import { beforeEach, describe, expect, it, vi } from "vitest";
import { braintrustReporter, type BraintrustReporterConfig } from "#evals/reporters/index.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import type { EveEval, EveEvalResult, EveEvalSessionResult, EveEvalTarget } from "#evals/types.js";
import { emptySessionView } from "#protocol/session-projection/public-view.js";
import type { TokenUsage } from "#shared/token-usage.js";

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

const gitMocks = vi.hoisted(() => ({
  resolveLocalGitMetadata: vi.fn(),
}));

vi.mock("#evals/runner/resolve-git-metadata.js", () => gitMocks);

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
      sessionEnded: false,
      data: "actual output",
      reply: "actual output",
      status: "completed",
      events: [],
      derived: {
        toolCalls: [
          {
            callId: "call-1",
            name: "search",
            input: { query: "test" },
            output: null,
            status: "completed",
            turnIndex: 0,
            sessionId: "session-123",
          },
        ],
        toolCallCount: 1,
        skillLoads: [],
        subagentCalls: [],
        subagentCallCount: 0,
        interactions: [],
        parked: false,
        messageCount: 1,
        reasoningBlockCount: 0,
        models: [],
      },
      sessionId: "session-123",
      traceContexts: [],
    },
    assertions: [
      { name: "succeeded", score: 1, severity: "gate", passed: true, errored: false },
      {
        name: "similarity",
        score: 1,
        severity: "soft",
        threshold: 0.6,
        passed: true,
        errored: false,
      },
    ],
    verdict: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function withUsage(
  result: EveEvalResult,
  usage: TokenUsage | undefined,
  sessions?: readonly EveEvalSessionResult[],
): EveEvalResult {
  return {
    ...result,
    result: { ...result.result, derived: { ...result.result.derived, usage }, sessions },
  };
}

function makeSession(
  sessionId: string,
  primary: boolean,
  models: readonly string[],
  usage: TokenUsage | undefined,
): EveEvalSessionResult {
  return {
    view: emptySessionView(),
    derived: { ...createEmptyDerivedFacts(), models, usage },
    events: [],
    primary,
    sessionId,
    state: undefined,
    traceContexts: [],
  };
}

function makeEval(): EveEval {
  return {
    _tag: "EveEval",
    id: "eval-1",
    test: async () => {},
  };
}

describe("braintrustReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.resolveLocalGitMetadata.mockReturnValue({ branch: "main", sha: "abc123" });
    braintrustMocks.init.mockResolvedValue({
      close: braintrustMocks.close,
      log: braintrustMocks.log,
      summarize: braintrustMocks.summarize,
    });
  });

  it("onEvalComplete is a no-op when experiment is not initialized", () => {
    const reporter = braintrustReporter(makeConfig());

    reporter.onEvalComplete(makeEvalResult());
  });

  it("onRunComplete is a no-op when experiment is not initialized", async () => {
    const reporter = braintrustReporter(makeConfig());

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
    const reporter = braintrustReporter(makeConfig());
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
            name: "judge.boolean",
            passed: false,
            errored: false,
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
              name: "judge.boolean",
              passed: false,
              errored: false,
              score: 0,
              severity: "soft",
              threshold: 0.8,
            },
          ],
        }),
      }),
    );
  });

  it("uploads eve trace ids and contexts", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());
    const result = makeEvalResult();
    const traceContext = {
      primary: true,
      sessionId: "session-123",
      spanId: "0123456789abcdef",
      traceFlags: 1,
      traceId: "0123456789abcdef0123456789abcdef",
    };

    reporter.onEvalComplete({
      ...result,
      result: { ...result.result, traceContexts: [traceContext] },
    });

    expect(braintrustMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          eveTraceContexts: [traceContext],
          eveTraceIds: [traceContext.traceId],
        }),
      }),
    );
  });

  it("logs each repeated attempt as its own row", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(makeEvalResult({ attempt: 1 }));
    reporter.onEvalComplete(makeEvalResult({ attempt: 2 }));

    expect(
      braintrustMocks.log.mock.calls.map(([row]) => [row.id, row.metadata.eveAttempt]),
    ).toEqual([
      ["eval-1#1", 1],
      ["eval-1#2", 2],
    ]);
  });

  it("does not replace structured null with accompanying reply text", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());
    const result = makeEvalResult();

    reporter.onEvalComplete({
      ...result,
      result: { ...result.result, reply: "Not the structured output.", data: null },
    });

    expect(braintrustMocks.log).toHaveBeenCalledWith(expect.objectContaining({ output: "" }));
  });

  it("scores repeated assertions by their lowest member and keeps each score in metadata", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      makeEvalResult({
        assertions: [
          { name: "similarity", passed: true, score: 0.8, severity: "soft", errored: false },
          { name: "similarity", passed: true, score: 0.6, severity: "soft", errored: false },
          { name: "similarity", passed: true, score: 1, severity: "gate", errored: false },
        ],
      }),
    );

    expect(braintrustMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        scores: { similarity: 0.6, "gate:similarity": 1 },
        metadata: expect.objectContaining({
          eveAssertionScores: [
            { name: "similarity", severity: "soft", score: 0.8 },
            { name: "similarity", severity: "soft", score: 0.6 },
            { name: "similarity", severity: "gate", score: 1 },
          ],
        }),
      }),
    );
  });

  it("logs labeled assertions under their label", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      makeEvalResult({
        assertions: [
          {
            name: "score [grounding]",
            key: "grounding",
            score: 0.8,
            severity: "soft",
            errored: false,
          },
          {
            name: "judge.boolean [citation]",
            key: "citation",
            score: 1,
            severity: "gate",
            errored: false,
          },
        ],
      }),
    );

    expect(braintrustMocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ scores: { grounding: 0.8, "gate:citation": 1 } }),
    );
  });

  it("logs eval usage as Braintrust token and cost metrics", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      withUsage(makeEvalResult(), {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        costUsd: 0.0125,
      }),
    );

    expect(braintrustMocks.log.mock.calls[0]?.[0].metrics).toEqual({
      toolCallCount: 1,
      subagentCallCount: 0,
      messageCount: 1,
      reasoningBlockCount: 0,
      prompt_tokens: 1200,
      completion_tokens: 300,
      tokens: 1500,
      prompt_cached_tokens: 800,
      prompt_cache_creation_tokens: 100,
      estimated_cost: 0.0125,
    });
  });

  it("omits estimated_cost when the eval usage has no cost", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(
      withUsage(makeEvalResult(), {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );

    const metrics = braintrustMocks.log.mock.calls[0]?.[0].metrics;
    expect(metrics).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, tokens: 15 });
    expect(metrics).not.toHaveProperty("estimated_cost");
  });

  it("logs no token metrics when the eval recorded no usage", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    reporter.onEvalComplete(makeEvalResult());

    expect(braintrustMocks.log.mock.calls[0]?.[0].metrics).toEqual({
      toolCallCount: 1,
      subagentCallCount: 0,
      messageCount: 1,
      reasoningBlockCount: 0,
    });
  });

  it("logs eval models and per-session models and usage in row metadata", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());
    const primaryUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.01,
    };
    const result = withUsage(makeEvalResult(), primaryUsage, [
      makeSession("session-123", true, ["openai/gpt-5.5"], primaryUsage),
      makeSession("session-456", false, ["anthropic/claude-sonnet-4.5"], undefined),
    ]);

    reporter.onEvalComplete({
      ...result,
      result: {
        ...result.result,
        derived: {
          ...result.result.derived,
          models: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5"],
        },
      },
    });

    const metadata = braintrustMocks.log.mock.calls[0]?.[0].metadata;
    expect(metadata).toMatchObject({
      eveModels: ["openai/gpt-5.5", "anthropic/claude-sonnet-4.5"],
      eveSessions: [
        {
          sessionId: "session-123",
          primary: true,
          models: ["openai/gpt-5.5"],
          usage: primaryUsage,
        },
        { sessionId: "session-456", primary: false, models: ["anthropic/claude-sonnet-4.5"] },
      ],
    });
    expect(metadata.eveSessions[1]).not.toHaveProperty("usage");
    expect(metadata).not.toHaveProperty("model");
  });

  it("merges configured metadata and tags over eve's experiment defaults", async () => {
    const reporter = braintrustReporter(
      makeConfig({
        metadata: { release: "1.2.3", eveTargetKind: "override" },
        tags: ["nightly", "eve"],
      }),
    );
    await reporter.onRunStart([makeEval()], makeTarget());

    const options = braintrustMocks.init.mock.calls[0]?.[0];
    expect(options.metadata).toMatchObject({
      eveEvalIds: ["eval-1"],
      eveTargetUrl: "http://127.0.0.1:3000",
      eveTargetKind: "override",
      release: "1.2.3",
    });
    expect(options.tags).toEqual(["eve", "target:local", "eval:eval-1", "nightly"]);
  });

  it("reads git metadata from the configured cwd", async () => {
    const reporter = braintrustReporter(makeConfig({ cwd: "/repo/agent" }));
    await reporter.onRunStart([makeEval()], makeTarget());

    expect(gitMocks.resolveLocalGitMetadata).toHaveBeenCalledWith("/repo/agent");
    expect(braintrustMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({ repoInfo: { commit: "abc123", branch: "main" } }),
    );
  });

  it("reads git metadata from process.cwd() by default", async () => {
    const reporter = braintrustReporter(makeConfig());
    await reporter.onRunStart([makeEval()], makeTarget());

    expect(gitMocks.resolveLocalGitMetadata).toHaveBeenCalledWith(process.cwd());
  });

  it("reports a configured repoInfo without reading git", async () => {
    const repoInfo = { commit: "def456", branch: "release", dirty: false };
    const reporter = braintrustReporter(makeConfig({ repoInfo }));
    await reporter.onRunStart([makeEval()], makeTarget());

    expect(gitMocks.resolveLocalGitMetadata).not.toHaveBeenCalled();
    const options = braintrustMocks.init.mock.calls[0]?.[0];
    expect(options.repoInfo).toEqual(repoInfo);
    expect(options).not.toHaveProperty("gitMetadataSettings");
  });

  it("reports no git metadata when repoInfo is null", async () => {
    const reporter = braintrustReporter(makeConfig({ repoInfo: null }));
    await reporter.onRunStart([makeEval()], makeTarget());

    expect(gitMocks.resolveLocalGitMetadata).not.toHaveBeenCalled();
    expect(braintrustMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({ repoInfo: null, gitMetadataSettings: { collect: "none" } }),
    );
  });
});
