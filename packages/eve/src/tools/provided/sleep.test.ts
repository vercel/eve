import { afterEach, describe, expect, it, vi } from "vitest";

import { sleep as workflowSleep } from "#compiled/@workflow/core/index.js";
import { sleepToolWorkflowReference } from "#execution/tools/sleep.js";
import { readToolBehavior } from "#tools/behavior.js";
import { sleep } from "#tools/provided/sleep.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  sleep: vi.fn(),
}));

describe("sleep", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defines a model-facing workflow tool", () => {
    const definition = sleep();

    expect(definition.description).toContain("before continuing");
    expect(readToolBehavior(definition)).toEqual({
      availability: [],
      handling: {
        kind: "workflow-tool",
        workflowId: sleepToolWorkflowReference.workflowId,
      },
    });
  });

  it("waits for the requested number of seconds in its workflow body", async () => {
    let wake: (() => void) | undefined;
    vi.mocked(workflowSleep).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    );
    const definition = sleep();
    const output = definition.execute({ seconds: 2.5001 }, {} as never);

    await vi.waitFor(() => {
      expect(workflowSleep).toHaveBeenCalledExactlyOnceWith(2_501);
    });

    wake?.();

    await expect(output).resolves.toEqual({ waitedSeconds: 2.5001 });
  });
});
