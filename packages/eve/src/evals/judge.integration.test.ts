import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import { executeTask } from "#evals/runner/execute-task.js";
import { computeEvalVerdict } from "#evals/runner/verdict.js";
import { createEvalTargetHandle } from "#evals/target.js";
import type { EveEvalContext, EveEvalJudgeConfig } from "#evals/types.js";

const client = new Client({ host: "https://eve.test" });
const target = createEvalTargetHandle({
  capabilities: { devRoutes: true },
  client,
  kind: "local",
  url: "https://eve.test",
});
function run(test: (t: EveEvalContext) => void, judge?: EveEvalJudgeConfig, timeoutMs?: number) {
  return executeTask({
    client,
    target,
    timeoutMs,
    evaluation: { _tag: "EveEval", id: "judge", test, judge },
  });
}
function model(probability = 0.8) {
  const evaluator = new Experimental_EvaluationMockModelV4({
    doEvaluate: async ({ questions }) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: "boolean" as const, probability }]),
      ),
      warnings: [],
      usage: { inputTokens: 10, outputTokens: 2 },
    }),
  });
  vi.spyOn(evaluator, "doEvaluate");
  return evaluator;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluation-backed judge runner", () => {
  it("uses evaluate's default model and leaves deterministic evals model-free", async () => {
    const evaluator = model();
    const factory = vi.fn(() => evaluator);
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { evaluationModel: factory });
    await run(() => {});
    expect(factory).not.toHaveBeenCalled();
    const outcome = await run((t) => {
      t.judge("Answers the request").atLeast(0.9);
    });
    expect(factory).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(outcome.assertions[0]).toMatchObject({ score: 0.8, severity: "soft", passed: false });
    expect(computeEvalVerdict(outcome)).toBe("scored");
  });

  it("supports model instances, overrides, and one SDK call for a batch", async () => {
    const inherited = model();
    const overridden = model(1);
    const outcome = await run(
      (t) => {
        t.judge("One");
        const handles = t.judge(
          {
            state: { response: "Hello Alice" },
            questions: {
              first: { type: "boolean", instructions: "Greets Alice" },
              second: { type: "boolean", instructions: "Is polite" },
            },
          },
          {
            model: overridden,
            modelOptions: { providerOptions: { fixture: { mode: "override" } } },
          },
        );
        handles.first.gate();
        handles.second.gate();
      },
      { model: inherited, modelOptions: { providerOptions: { fixture: { mode: "inherited" } } } },
    );
    expect(vi.mocked(inherited.doEvaluate).mock.calls).toHaveLength(1);
    expect(vi.mocked(overridden.doEvaluate).mock.calls).toHaveLength(1);
    expect(vi.mocked(inherited.doEvaluate).mock.calls[0]?.[0].providerOptions).toEqual({
      fixture: { mode: "inherited" },
    });
    expect(vi.mocked(overridden.doEvaluate).mock.calls[0]?.[0]).toMatchObject({
      state: { response: "Hello Alice" },
      providerOptions: { fixture: { mode: "override" } },
    });
    expect(outcome.assertions.map((item) => item.score)).toEqual([0.8, 1, 1]);
  });

  it.each([
    { criteria: [], batch: false },
    { criteria: ["Only level"], batch: false },
    { criteria: [], batch: true },
    { criteria: ["Only level"], batch: true },
  ])("rejects an undersized score rubric before provider I/O: %j", async ({ criteria, batch }) => {
    const evaluator = model();
    const outcome = await run(
      (t) => {
        const question = { type: "score" as const, instructions: "Grade clarity.", criteria };
        if (batch) {
          const handles = t.judge({
            questions: {
              clarity: question,
              accurate: { type: "boolean", instructions: "Is the response accurate?" },
            },
          });
          handles.clarity.atLeast(0);
        } else {
          t.judge(question).atLeast(0);
        }
      },
      { model: evaluator },
    );
    expect(evaluator.doEvaluate).not.toHaveBeenCalled();
    expect(outcome.assertions).toHaveLength(batch ? 2 : 1);
    for (const assertion of outcome.assertions) {
      expect(assertion).toMatchObject({ score: 0, severity: "gate", passed: false });
      expect(assertion.message).toContain(
        "score criteria must contain at least two ordered levels",
      );
    }
    expect(computeEvalVerdict(outcome)).toBe("failed");
  });

  it.each(["missing", "invalid", "provider", "unsupported"])(
    "fails the whole batch for %s answers or capability",
    async (failure) => {
      const evaluator = new Experimental_EvaluationMockModelV4({
        supportedQuestionTypes: failure === "unsupported" ? ["choice"] : ["boolean"],
        doEvaluate: async (): Promise<
          Awaited<ReturnType<Experimental_EvaluationMockModelV4["doEvaluate"]>>
        > => {
          if (failure === "provider") throw new Error("Evaluation credentials unavailable");
          return {
            answers:
              failure === "missing"
                ? {}
                : {
                    a: { type: "boolean", probability: 2 },
                    b: { type: "boolean", probability: 1 },
                  },
            warnings: [],
          };
        },
      });
      const outcome = await run(
        (t) => {
          t.judge({
            questions: {
              a: { type: "boolean", instructions: "A" },
              b: { type: "boolean", instructions: "B" },
            },
          });
        },
        { model: evaluator },
      );
      expect(outcome.skipReason).toBeUndefined();
      expect(outcome.assertions).toHaveLength(2);
      expect(outcome.assertions.every((a) => !a.passed && a.severity === "gate")).toBe(true);
      expect(computeEvalVerdict(outcome)).toBe("failed");
    },
  );

  it("bounds finalization when a provider ignores the eval deadline", async () => {
    const evaluator = new Experimental_EvaluationMockModelV4({
      doEvaluate: () => new Promise(() => {}),
    });
    vi.spyOn(evaluator, "doEvaluate");
    const outcome = await run(
      (t) => {
        t.judge("A");
      },
      { model: evaluator },
      20,
    );
    expect(vi.mocked(evaluator.doEvaluate).mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
    expect(outcome.assertions[0]).toMatchObject({ passed: false, severity: "gate" });
    expect(computeEvalVerdict(outcome)).toBe("failed");
  });
});
