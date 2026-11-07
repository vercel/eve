import { setTimeout as nodeDelay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { delay } from "./delay.web.ts";

describe("the abortable wait the browser build uses", () => {
  it("resolves after its time", async () => {
    await expect(delay(1)).resolves.toBeUndefined();
  });

  it("rejects as Node's does when its signal aborts, before or while it waits", async () => {
    const reason = new Error("stop");
    for (const abortFirst of [true, false]) {
      const controller = new AbortController();
      const node = new AbortController();
      if (abortFirst) {
        controller.abort(reason);
        node.abort(reason);
      }
      const ours = delay(10_000, controller.signal).catch((error: unknown) => error);
      const theirs = nodeDelay(10_000, undefined, { signal: node.signal }).catch(
        (error: unknown) => error,
      );
      if (!abortFirst) {
        controller.abort(reason);
        node.abort(reason);
      }
      const [mine, expected] = await Promise.all([ours, theirs]);
      expect(mine).toMatchObject({
        cause: reason,
        message: (expected as Error).message,
        name: (expected as Error).name,
      });
    }
  });
});
