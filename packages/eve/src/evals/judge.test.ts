import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { buildJudgeContext } from "#evals/judge.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import type { AssertionHandle, EveEvalTaskResult, JudgeContext } from "#evals/types.js";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("#ai/evaluate.js", () => ({ evaluate }));
afterEach(() => vi.resetAllMocks());

function setup() {
  const collector = new AssertionCollector();
  const controller = new AbortController();
  const judge = buildJudgeContext({
    collector,
    signal: controller.signal,
    getInput: () => "Name the source.",
    getReply: () => "A sourced answer.",
    judge: undefined,
  });
  return { judge, collector, controller };
}
function result(answers: Record<string, unknown>) {
  return {
    answers,
    response: { modelId: "test-evaluator", timestamp: new Date(0) },
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    warnings: [],
  };
}
function emptyTaskResult(): EveEvalTaskResult {
  return {
    derived: createEmptyDerivedFacts(),
    events: [],
    finalMessage: null,
    output: null,
    status: "completed",
    traceContexts: [],
  };
}

describe("judge", () => {
  it("expands criteria and retains assertion handles and diagnostics", async () => {
    evaluate.mockResolvedValue(result({ judgment: { type: "boolean", probability: 0.7 } }));
    const { judge, collector, controller } = setup();
    const handle = judge("cites a source").label("citation").atLeast(0.8);
    expect(handle).not.toHaveProperty("then");
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        abortSignal: controller.signal,
        state: { input: "Name the source.", output: "A sourced answer." },
        questions: { judgment: { type: "boolean", instructions: "cites a source" } },
      }),
    );
    const [assertion] = await collector.finalize(emptyTaskResult());
    expect(assertion).toMatchObject({
      name: "judge.boolean [citation]",
      score: 0.7,
      severity: "soft",
      threshold: 0.8,
      passed: false,
      metadata: { judge: "test-evaluator", answer: { probability: 0.7 }, usageScope: "assertion" },
    });
    expect(assertion?.message).toContain('"cites a source"');
  });

  it("shares a batch request, normalizes rubrics, and keeps expectations local", async () => {
    evaluate.mockResolvedValue(
      result({
        accurate: { type: "boolean", probability: 0.2 },
        clarity: { type: "score", score: 1.5 },
        outcome: { type: "choice", choice: "answered" },
      }),
    );
    const { judge, collector } = setup();
    const handles = judge({
      state: { response: "hello" },
      questions: {
        accurate: { type: "boolean", instructions: "Is it accurate?" },
        clarity: {
          type: "score",
          instructions: "Grade clarity",
          criteria: ["Poor", "Fair", "Clear"],
        },
        outcome: {
          type: "choice",
          instructions: "Classify",
          criteria: { answered: "Answer", declined: "Decline" },
          expected: "answered",
        },
      },
    });
    handles.clarity.atLeast(0.8);
    handles.outcome.gate();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0].questions.outcome).not.toHaveProperty("expected");
    const assertions = await collector.finalize(emptyTaskResult());
    expect(assertions.map(({ name, score, passed }) => ({ name, score, passed }))).toEqual([
      { name: "judge.boolean.accurate", score: 0.2, passed: true },
      { name: "judge.score.clarity", score: 0.75, passed: false },
      { name: "judge.choice.outcome", score: 1, passed: true },
    ]);
    expect(assertions.every((item) => item.metadata?.usageScope === "batch")).toBe(true);
  });

  it("scores a different selected choice as zero", async () => {
    evaluate.mockResolvedValue(result({ judgment: { type: "choice", choice: "declined" } }));
    const { judge, collector } = setup();
    judge({
      type: "choice",
      instructions: "Classify",
      criteria: { answered: null, declined: null },
      expected: "answered",
    }).gate();
    expect((await collector.finalize(emptyTaskResult()))[0]).toMatchObject({
      score: 0,
      passed: false,
    });
  });

  it("captures JSON state and questions before later mutations", async () => {
    evaluate.mockResolvedValue(result({ judgment: { type: "boolean", probability: 1 } }));
    const { judge, collector } = setup();
    const on = { values: [1] };
    const question = { type: "boolean" as const, instructions: "Original" };
    judge(question, { on });
    on.values.push(2);
    question.instructions = "Changed";
    await collector.finalize(emptyTaskResult());
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      state: { output: { values: [1] } },
      questions: { judgment: { instructions: "Original" } },
    });
  });

  it("preserves explicit null and transcript values", async () => {
    evaluate.mockResolvedValue(result({ judgment: { type: "boolean", probability: 1 } }));
    const { judge, collector } = setup();
    judge("check", { on: null });
    judge("check", { on: "user: Hello\nassistant: Hi" });
    await collector.finalize(emptyTaskResult());
    expect(evaluate.mock.calls.map(([request]) => request.state.output)).toEqual([
      null,
      "user: Hello\nassistant: Hi",
    ]);
  });

  it("validates choice expectations before provider I/O", async () => {
    const { judge, collector } = setup();
    // @ts-expect-error Expected must be an authored choice key.
    judge({ type: "choice", instructions: "Classify", criteria: { yes: null }, expected: "no" });
    expect((await collector.finalize(emptyTaskResult()))[0]).toMatchObject({
      severity: "gate",
      passed: false,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("turns shared request errors into failed gates for every question", async () => {
    evaluate.mockRejectedValue(new Error("Evaluation unavailable"));
    const { judge, collector } = setup();
    const handles = judge({
      questions: {
        a: { type: "boolean", instructions: "A" },
        b: { type: "boolean", instructions: "B" },
      },
    });
    handles.a.soft();
    handles.b.atLeast(0);
    expect(await collector.finalize(emptyTaskResult())).toEqual([
      expect.objectContaining({
        severity: "gate",
        passed: false,
        message: "Evaluation unavailable",
      }),
      expect.objectContaining({
        severity: "gate",
        passed: false,
        message: "Evaluation unavailable",
      }),
    ]);
  });

  it("does not hang when a provider ignores cancellation", async () => {
    evaluate.mockReturnValue(new Promise(() => {}));
    const { judge, collector, controller } = setup();
    judge("check");
    controller.abort(new Error("Deadline reached"));
    expect((await collector.finalize(emptyTaskResult()))[0]).toMatchObject({
      severity: "gate",
      passed: false,
      message: "Deadline reached",
    });
  });

  it("rejects empty batches", () => {
    expect(() => setup().judge({ questions: {} })).toThrow("non-empty");
    expect(evaluate).not.toHaveBeenCalled();
  });
});

function checkTypes(judge: JudgeContext) {
  expectTypeOf(judge("criteria")).toEqualTypeOf<AssertionHandle>();
  const batch = judge({
    questions: {
      choice: {
        type: "choice",
        instructions: "Classify",
        criteria: { yes: null, no: null },
        expected: "yes",
      },
    },
  });
  expectTypeOf(batch.choice).toEqualTypeOf<AssertionHandle>();
  // @ts-expect-error Batch handle keys are inferred.
  void batch.missing;
  judge({
    questions: {
      // @ts-expect-error Expected must be an authored option key, including in batches.
      choice: { type: "choice", instructions: "Classify", criteria: { yes: null }, expected: "no" },
    },
  });
  // @ts-expect-error Batch state replaces the per-call on option.
  judge({ questions: { check: { type: "boolean", instructions: "Check" } } }, { on: "other" });
}
void checkTypes;
