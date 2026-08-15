import { describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sendTurnControlStep } from "#execution/turn-control-protocol.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

describe("sendTurnControlStep", () => {
  it("ignores an obsolete send after the session driver releases its hook", async () => {
    vi.mocked(resumeHook).mockRejectedValue(new HookNotFoundError("turn-control"));

    await expect(
      sendTurnControlStep({
        controlToken: "turn-control",
        payload: { kind: "turn-delivery-cancelled", requestId: "delivery-1" },
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates unexpected delivery failures", async () => {
    const failure = new Error("world unavailable");
    vi.mocked(resumeHook).mockRejectedValue(failure);

    await expect(
      sendTurnControlStep({
        controlToken: "turn-control",
        payload: { kind: "turn-delivery-cancelled", requestId: "delivery-1" },
      }),
    ).rejects.toBe(failure);
  });
});
