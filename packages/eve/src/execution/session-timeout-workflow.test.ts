import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "#compiled/@workflow/core/index.js";

import { signalSessionTimeoutStep } from "#execution/session-timeout-steps.js";
import { sessionTimeoutWorkflow } from "#execution/session-timeout-workflow.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  sleep: vi.fn(),
}));

vi.mock("./session-timeout-steps.js", () => ({
  signalSessionTimeoutStep: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("sessionTimeoutWorkflow", () => {
  it("signals the session only after its durable sleep settles", async () => {
    let wake: (() => void) | undefined;
    vi.mocked(sleep).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
    );

    const deadline = new Date("2026-02-01T00:00:00.000Z");
    const timer = sessionTimeoutWorkflow({ deadline, token: "session-1:session-timeout" });
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledWith(deadline);
    });
    expect(signalSessionTimeoutStep).not.toHaveBeenCalled();

    wake?.();
    await timer;

    expect(signalSessionTimeoutStep).toHaveBeenCalledWith({
      token: "session-1:session-timeout",
    });
  });
});
