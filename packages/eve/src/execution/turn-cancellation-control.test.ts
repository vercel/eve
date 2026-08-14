import { afterEach, describe, expect, it, vi } from "vitest";

import { createTurnCancellationControl } from "#execution/turn-cancellation-control.js";
import { turnCancellationHookToken } from "#execution/turn-cancellation-token.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

const createActiveStepAbortControllerMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createActiveStepAbortController: (...args: unknown[]) =>
    createActiveStepAbortControllerMock(...args),
}));

describe("turnCancellationHookToken", () => {
  it("derives a private token from the turn control token", () => {
    expect(turnCancellationHookToken("wrun_abc:turn-control:1")).toBe(
      "abrt_wrun_abc_turn-control_1_cancel",
    );
  });
});

describe("createTurnCancellationControl", () => {
  afterEach(() => {
    createActiveStepAbortControllerMock.mockReset();
  });

  it("creates a deterministic active-step controller", async () => {
    const controller = installActiveStepAbortController();

    const control = createTurnCancellationControl({ controlToken: "wrun_abc:turn-control:1" });

    expect(control!.signal).toBe(controller.signal);
    expect(createActiveStepAbortControllerMock).toHaveBeenCalledWith({
      token: "abrt_wrun_abc_turn-control_1_cancel",
    });
  });

  it("settles when the active-step signal aborts with a turn cancellation", async () => {
    const controller = installActiveStepAbortController();

    const control = createTurnCancellationControl({ controlToken: "session-1" });

    controller.abort(new TurnCancelledError());
    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
    expect(control!.signal.reason).toBeInstanceOf(TurnCancelledError);
  });

  it("disposes idempotently", async () => {
    const { dispose } = installActiveStepAbortController();

    const control = createTurnCancellationControl({ controlToken: "session-1" });

    await control!.dispose();
    await control!.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

function installActiveStepAbortController(): AbortController & {
  dispose: ReturnType<typeof vi.fn>;
} {
  const controller = new AbortController() as AbortController & {
    dispose: ReturnType<typeof vi.fn>;
  };
  controller.dispose = vi.fn();
  createActiveStepAbortControllerMock.mockReturnValue(controller);
  return controller;
}
