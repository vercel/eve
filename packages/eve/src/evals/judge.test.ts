import { afterEach, describe, expect, it, vi } from "vitest";

import { AssertionCollector } from "#evals/assertions/collector.js";
import { buildJudgeContext } from "#evals/judge.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import type { EveEvalTaskResult } from "#evals/types.js";

const mocks = vi.hoisted(() => ({
  closedQA: vi.fn(),
  createAutoevalsClient: vi.fn(() => ({ kind: "autoevals-client" })),
  factuality: vi.fn(),
  sql: vi.fn(),
  summary: vi.fn(),
}));

vi.mock("autoevals", () => ({
  ClosedQA: mocks.closedQA,
  Factuality: mocks.factuality,
  Sql: mocks.sql,
  Summary: mocks.summary,
}));

vi.mock("#evals/autoevals-client.js", () => ({
  createAutoevalsClient: mocks.createAutoevalsClient,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildJudgeContext", () => {
  it("reports the prompt, criteria, response, and autoevals explanation", async () => {
    mocks.closedQA.mockResolvedValueOnce({
      name: "ClosedQA",
      score: 0,
      metadata: {
        choice: "N",
        rationale: "The response makes no mention of a source.",
        tokens: 42,
      },
    });
    const collector = new AssertionCollector();
    const judge = buildJudgeContext({
      collector,
      getInput: () => "Name the source for this claim.",
      getReply: () => "It is widely believed.",
      judge: { model: "openai/gpt-5.4-mini" },
    });

    judge.autoevals.closedQA("cites a source").label("source citation").atLeast(0.8);
    const [assertion] = await collector.finalize(emptyTaskResult());

    expect(mocks.closedQA).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: "cites a source",
        input: "Name the source for this claim.",
        model: "openai/gpt-5.4-mini",
        output: "It is widely believed.",
      }),
    );
    expect(assertion).toMatchObject({
      name: "judge.autoevals.closedQA [source citation]",
      score: 0,
      severity: "soft",
      threshold: 0.8,
      passed: false,
      message: [
        'prompt: "Name the source for this claim."',
        'criteria: "cites a source"',
        'response: "It is widely believed."',
        'rationale: "The response makes no mention of a source."',
        'choice: "N"',
      ].join("\n"),
      metadata: {
        autoevalsName: "ClosedQA",
        choice: "N",
        criteria: "cites a source",
        input: "Name the source for this claim.",
        judge: "openai/gpt-5.4-mini",
        output: "It is widely believed.",
        rationale: "The response makes no mention of a source.",
        tokens: 42,
      },
    });
  });

  it("reports the custom value and expected answer for comparison graders", async () => {
    mocks.factuality.mockResolvedValueOnce({
      name: "Factuality",
      score: 1,
      metadata: { choice: "A" },
    });
    const collector = new AssertionCollector();
    const judge = buildJudgeContext({
      collector,
      getInput: () => "What is the capital of France?",
      getReply: () => "This value is not graded.",
      judge: { model: "openai/gpt-5.4-mini" },
    });

    judge.autoevals.factuality("Paris", { on: "The capital is Paris." });
    const [assertion] = await collector.finalize(emptyTaskResult());

    expect(assertion).toMatchObject({
      passed: true,
      message: [
        'prompt: "What is the capital of France?"',
        'expected: "Paris"',
        'response: "The capital is Paris."',
        'choice: "A"',
      ].join("\n"),
      metadata: {
        expected: "Paris",
        output: "The capital is Paris.",
      },
    });
  });
});

function emptyTaskResult(): EveEvalTaskResult {
  return {
    derived: createEmptyDerivedFacts(),
    events: [],
    finalMessage: null,
    output: null,
    status: "completed",
  };
}
