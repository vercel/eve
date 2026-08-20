import { describe, expect, it } from "vitest";

import { always, never, once } from "#public/tools/approval/approval-helpers.js";
import { readDurableDynamicCallback } from "#shared/durable-dynamic-tool-callbacks.js";

function getStepRegistry(): Map<string, Function> {
  return (globalThis as Record<symbol, Map<string, Function> | undefined>)[
    Symbol.for("@workflow/core//registeredSteps")
  ]!;
}

describe("dynamic tool approval helpers", () => {
  it.each([
    ["always", always(), "user-approval"],
    ["never", never(), "not-applicable"],
  ] as const)("gives %s a stable replay descriptor", async (_name, policy, expected) => {
    const reference = readDurableDynamicCallback(policy);
    expect(reference).toEqual({
      closure: {},
      stepId: expect.stringMatching(/^eve:dynamic-tool-helper\/\/approval\//),
    });

    expect(await getStepRegistry().get(reference!.stepId)!(reference!.closure, {})).toBe(expected);
  });

  it("replays once against the current approval context", async () => {
    const reference = readDurableDynamicCallback(once())!;
    const replay = getStepRegistry().get(reference.stepId)!;

    expect(
      await replay(reference.closure, {
        approvedTools: new Set(),
        toolName: "guarded",
      }),
    ).toBe("user-approval");
    expect(
      await replay(reference.closure, {
        approvedTools: new Set(["guarded"]),
        toolName: "guarded",
      }),
    ).toBe("not-applicable");
  });
});
