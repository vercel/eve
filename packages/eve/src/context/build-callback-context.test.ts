import { describe, expect, it, vi } from "vitest";

import { withRuntimeSandboxLifecycle } from "#context/build-callback-context.js";

describe("withRuntimeSandboxLifecycle", () => {
  it("preserves custom methods and private receivers on frozen provider sessions", async () => {
    class CustomSession {
      readonly #token = "custom-session-ok";
      probe() {
        return this.#token;
      }
    }
    const target = Object.freeze(new CustomSession());
    const deleteSandbox = vi.fn(async () => {});
    const stop = vi.fn(async () => {});

    const session = withRuntimeSandboxLifecycle(
      target as never,
      deleteSandbox,
      stop,
    ) as CustomSession & {
      delete(): Promise<void>;
      stop(): Promise<void>;
    };

    expect(session.probe()).toBe("custom-session-ok");
    await session.delete();
    await session.stop();
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
