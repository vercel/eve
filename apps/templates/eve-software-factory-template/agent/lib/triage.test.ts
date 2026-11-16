import assert from "node:assert/strict";
import { mock, test } from "node:test";

let answers: Record<string, unknown> = {};
let request: any;
mock.module("eve/ai", {
  namedExports: {
    decide: (options: unknown) => {
      request = options;
      return Promise.resolve({ answers });
    },
  },
});
mock.module("eve/tools", {
  namedExports: { defineTool: (config: unknown) => config },
});
const triageModule = await import("../tools/triage_work_item.js");
const triage = triageModule.default as any;
const diagnoseModule = await import("../tools/diagnose_ci_failure.js");
const diagnose = diagnoseModule.default as any;

const input = {
  body: "x".repeat(20_000),
  candidates: [{ number: 42, title: "Existing report" }],
  labels: Array.from({ length: 45 }, (_, index) => ({ name: `area-${index}` })),
  title: "Duplicate email delivery",
};

test("typed triage bounds model context and applies probability thresholds to the supplied vocabulary", async () => {
  answers = {
    actionable: { probability: 0.9 },
    complexity: { choice: "small" },
    duplicate_0: { probability: 0.84 },
    label_0: { probability: 0.69 },
    label_1: { probability: 0.7 },
    label_2: { probability: 0.99 },
    label_3: { probability: 0.8 },
    label_4: { probability: 0.9 },
    priority: { choice: "high" },
    type: { choice: "bug" },
  };
  const result = await triage.execute(input, {});
  assert.equal(result.lane, "pipeline");
  assert.equal(result.priority, "high");
  assert.deepEqual(result.labels, ["area-2", "area-4", "area-3"]);
  assert.deepEqual(result.duplicates, []);
  assert.ok(request.state.body.length < 12_100);
  assert.equal(request.questions.label_40, undefined);

  answers.duplicate_0 = { probability: 0.85 };
  const duplicate = await triage.execute(input, {});
  assert.equal(duplicate.lane, "duplicate");
  assert.deepEqual(duplicate.duplicates, [42]);
  answers = { actionable: { probability: 0.9 }, type: { choice: "question" } };
  assert.equal((await triage.execute(input, {})).lane, "answer");
  answers = { needs_clarification: { probability: 0.8 } };
  assert.equal((await triage.execute(input, {})).lane, "clarify");
});

test("CI diagnosis does not turn missing evidence into a passing or code-fix verdict", async () => {
  request = null;
  assert.deepEqual(await diagnose.execute({ log: "  " }, {}), {
    cause: null,
    confidence: null,
    fix_with_code: null,
  });
  assert.equal(request, null);
  for (const [cause, fix] of [
    ["code", true],
    ["infrastructure", false],
    ["flaky", false],
    ["configuration", false],
  ] as const) {
    answers = { cause: { choice: cause, probabilities: { [cause]: 0.9 } } };
    // biome-ignore lint/performance/noAwaitInLoops: each case changes the model reply
    const result = await diagnose.execute(
      { log: `failure ${"x".repeat(17_000)} token=x_ghs_${"A".repeat(32)}` },
      {}
    );
    assert.equal(result.cause, cause);
    assert.equal(result.fix_with_code, fix);
    assert.equal(result.confidence, 0.9);
    const evidence = request as any;
    assert.ok(evidence.state.failed_job_log.length <= 16_000);
    assert.ok(!evidence.state.failed_job_log.includes("ghs_"));
  }
});
