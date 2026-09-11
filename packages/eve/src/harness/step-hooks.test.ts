import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildStepHooks } from "#harness/step-hooks.js";
import type { HarnessEmissionState } from "#harness/emission.js";

const emissionState: HarnessEmissionState = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

describe("buildStepHooks", () => {
  it("emits step.started from onStepStart, not prepareStep", async () => {
    const emit = vi.fn(async () => {});
    const hooks = buildStepHooks({
      emit,
      emissionState,
      execution: {
        cachePath: { kind: "none" },
        kind: "model",
        marker: undefined,
        modelReference: { id: "test-model" },
      },
    });
    const messages: ModelMessage[] = [{ content: "hello", role: "user" }];

    await hooks.prepareStep({
      messages,
      model: {} as never,
      instructions: undefined,
      initialInstructions: undefined,
      initialMessages: [],
      responseMessages: [],
      runtimeContext: {},
      toolsContext: {},
      experimental_sandbox: undefined,
      stepNumber: 0,
      steps: [],
    });
    expect(emit).not.toHaveBeenCalled();

    await Reflect.apply(hooks.onStepStart, null, [{ messages }]);

    expect(emit).toHaveBeenCalledWith(
      {
        data: { modelId: "test-model", sequence: 0, stepIndex: 0, turnId: "turn_0" },
        type: "step.started",
      },
      messages,
    );
  });
});
