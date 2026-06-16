import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { createEvalTargetHandle } from "#evals/target.js";
import type { AssertionResult, EveEval, EveEvalTaskResult } from "#evals/types.js";

const mockedRunnerDependencies = vi.hoisted(() => ({
  executeTask: vi.fn(),
}));

vi.mock("./execute-task.js", () => ({
  executeTask: mockedRunnerDependencies.executeTask,
}));

import { executeEval } from "#evals/runner/execute-eval.js";

function createTaskResult(label: string): EveEvalTaskResult {
  return {
    output: label,
    finalMessage: label,
    status: "completed",
    events: [],
    derived: createEmptyDerivedFacts(),
  };
}

function taskOutcome(assertions: readonly AssertionResult[] = [], error?: string) {
  return { result: createTaskResult("actual"), assertions, error };
}

function gate(passed: boolean): AssertionResult {
  return { name: "gate", score: passed ? 1 : 0, severity: "gate", passed };
}

function softMiss(): AssertionResult {
  return { name: "soft", score: 0.5, severity: "soft", threshold: 0.9, passed: false };
}

function createEval(overrides: Partial<EveEval> = {}): EveEval {
  return {
    _tag: "EveEval",
    id: "test-eval",
    test: async () => {},
    ...overrides,
  } as EveEval;
}

// `executeTask` is mocked in these tests, so the client never reaches the
// network. We pass a real `Client` instance to satisfy the type.
const unusedClient = new Client({ host: "http://localhost" });

const localTarget = createEvalTargetHandle({
  capabilities: { devRoutes: true },
  client: unusedClient,
  kind: "local",
  url: "http://localhost",
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("executeEval", () => {
  it("passes when every assertion passed and forwards the recorded assertions", async () => {
    const assertions = [gate(true)];
    mockedRunnerDependencies.executeTask.mockResolvedValue(taskOutcome(assertions));

    const result = await executeEval({
      evaluation: createEval(),
      target: localTarget,
      client: unusedClient,
    });

    expect(result.verdict).toBe("passed");
    expect(result.assertions).toEqual(assertions);
  });

  it("fails the eval when a gate assertion failed", async () => {
    mockedRunnerDependencies.executeTask.mockResolvedValue(taskOutcome([gate(false)]));

    const result = await executeEval({
      evaluation: createEval(),
      target: localTarget,
      client: unusedClient,
    });

    expect(result.verdict).toBe("failed");
  });

  it("marks below-threshold soft assertions as scored without failing", async () => {
    mockedRunnerDependencies.executeTask.mockResolvedValue(taskOutcome([gate(true), softMiss()]));

    const result = await executeEval({
      evaluation: createEval(),
      target: localTarget,
      client: unusedClient,
    });

    expect(result.verdict).toBe("scored");
  });

  it("fails when the test body threw (executeTask reports an error)", async () => {
    mockedRunnerDependencies.executeTask.mockResolvedValue(
      taskOutcome([gate(true)], "expectOk failed"),
    );

    const result = await executeEval({
      evaluation: createEval(),
      target: localTarget,
      client: unusedClient,
    });

    expect(result.verdict).toBe("failed");
    expect(result.error).toContain("expectOk failed");
  });

  it("marks execution errors as failed with the error recorded", async () => {
    mockedRunnerDependencies.executeTask.mockRejectedValue(new Error("connection refused"));

    const result = await executeEval({
      evaluation: createEval(),
      target: localTarget,
      client: unusedClient,
    });

    expect(result.verdict).toBe("failed");
    expect(result.error).toContain("connection refused");
  });

  it("prefers the CLI timeout override over the eval timeout", async () => {
    mockedRunnerDependencies.executeTask.mockResolvedValue(taskOutcome());

    await executeEval({
      evaluation: createEval({ id: "timeouts", timeoutMs: 5_000 }),
      target: localTarget,
      client: unusedClient,
      timeoutMs: 1_000,
    });

    expect(mockedRunnerDependencies.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });
});
