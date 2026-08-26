import { describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { decodeTurnControlPayload } from "#execution/turn-control-codec.js";
import { sendTurnControlStep } from "#execution/turn-control-protocol.js";
import { resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: vi.fn(),
}));

describe("turn control compatibility", () => {
  it("preserves additive fields understood only by a newer turn", () => {
    const payload = {
      action: {
        futureActionDetail: { enabled: true },
        kind: "park",
        serializedContext: { futureContext: true },
        sessionState: { futureState: true, version: 1 },
      },
      futureControlDetail: true,
      kind: "turn-result",
    };

    expect(decodeTurnControlPayload(payload)).toBe(payload);
  });

  it("allows a newer session state version when its driver-facing shape is compatible", () => {
    const payload = {
      action: {
        kind: "park",
        serializedContext: {},
        sessionState: { version: 2 },
      },
      kind: "turn-result",
    };

    expect(decodeTurnControlPayload(payload)).toBe(payload);
  });

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
