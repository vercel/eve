import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreparedTurnControl } from "#execution/session/turn-control.js";

afterEach(() => vi.unstubAllGlobals());

describe("createPreparedTurnControl", () => {
  it("constructs cancellation and steering controllers eagerly", () => {
    const NativeAbortController = AbortController;
    const construct = vi.fn(() => new NativeAbortController());
    vi.stubGlobal(
      "AbortController",
      class {
        constructor() {
          return construct();
        }
      },
    );

    const control = createPreparedTurnControl();

    expect(construct).toHaveBeenCalledTimes(2);
    expect(control.cancellation).not.toBe(control.steering);
  });

  it("retires both unused controls", () => {
    const control = createPreparedTurnControl();

    control.dispose();
    control.dispose();

    expect(control.cancellation.signal.aborted).toBe(true);
    expect(control.steering.signal.aborted).toBe(true);
  });
});
