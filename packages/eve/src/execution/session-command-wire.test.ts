import { describe, expect, it } from "vitest";

import { sendCommandToDelivery } from "#execution/session-command-wire.js";

describe("sendCommandToDelivery", () => {
  it("emits the deliver envelope with the single-payload compat mirror", () => {
    const payload = { message: "hello" };

    const caller = {
      callId: "call-1",
      replyTo: { kind: "hook", token: "parent-tok" },
      subagentName: "child",
    } as const;
    const wire = sendCommandToDelivery({
      auth: null,
      caller,
      kind: "send",
      payload,
      requestId: "req-1",
      turnPolicy: "experimental-steer",
    });

    expect(wire).toEqual({
      auth: null,
      caller,
      kind: "deliver",
      payload,
      payloads: [payload],
      requestId: "req-1",
      turnPolicy: "experimental-steer",
    });
    // The 0.30.3–0.30.8 parked decode reads `.payload`; everything else reads
    // `payloads`. Both views must reference the same delivery.
    expect(wire.payloads[0]).toBe(wire.payload);
  });
});
