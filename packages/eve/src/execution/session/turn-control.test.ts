import { afterEach, describe, expect, it, vi } from "vitest";

import { createTurnControl } from "#execution/session/turn-control.js";

afterEach(() => vi.unstubAllGlobals());

describe("createTurnControl", () => {
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

    const control = createTurnControl();

    expect(construct).toHaveBeenCalledTimes(2);
    expect(control.cancellation).not.toBe(control.steering);
  });

  it("retires both unused controls", () => {
    const control = createTurnControl();

    control.dispose();
    control.dispose();

    expect(control.cancellation.signal.aborted).toBe(true);
    expect(control.steering.signal.aborted).toBe(true);
  });
});
