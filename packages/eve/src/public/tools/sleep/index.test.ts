import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { readTurnSleepDurationMs } from "#harness/turn-sleep.js";
import { sleep } from "#public/tools/sleep/index.js";

describe("sleep", () => {
  it("defines a model-facing tool that requests a turn sleep in seconds", async () => {
    const definition = sleep();
    const ctx = new ContextContainer();

    const output = await contextStorage.run(ctx, () =>
      definition.execute({ seconds: 2.5 }, {} as never),
    );

    expect(definition.description).toContain("before continuing");
    expect(output).toEqual({ waitedSeconds: 2.5 });
    expect(readTurnSleepDurationMs(ctx)).toBe(2_500);
  });

  it("shares concurrent waits by keeping the longest duration", async () => {
    const definition = sleep();
    const ctx = new ContextContainer();

    await contextStorage.run(ctx, async () => {
      await definition.execute({ seconds: 4 }, {} as never);
      await definition.execute({ seconds: 1 }, {} as never);
    });

    expect(readTurnSleepDurationMs(ctx)).toBe(4_000);
  });
});
