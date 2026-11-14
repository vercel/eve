import { afterEach, describe, expect, it, vi } from "vitest";

import { createTurnControl, nextTurnControl } from "#execution/session/turn-control.js";

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
});

describe("nextTurnControl", () => {
  it("keeps the controls a turn left unaborted", () => {
    const used = createTurnControl();
    const next = nextTurnControl(used);
    expect(next.cancellation).toBe(used.cancellation);
    expect(next.steering).toBe(used.steering);
  });

  it("replaces only the controls a turn aborted", () => {
    const steered = createTurnControl();
    steered.steering.abort();
    const afterSteering = nextTurnControl(steered);
    expect(afterSteering.cancellation).toBe(steered.cancellation);
    expect(afterSteering.steering).not.toBe(steered.steering);
    expect(afterSteering.steering.signal.aborted).toBe(false);

    const cancelled = createTurnControl();
    cancelled.cancellation.abort();
    const afterCancel = nextTurnControl(cancelled);
    expect(afterCancel.cancellation).not.toBe(cancelled.cancellation);
    expect(afterCancel.cancellation.signal.aborted).toBe(false);
    expect(afterCancel.steering).toBe(cancelled.steering);
  });
});
