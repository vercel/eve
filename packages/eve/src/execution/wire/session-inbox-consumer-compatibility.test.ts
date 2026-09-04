import { describe, expect, it } from "vitest";

import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";

interface Eve0308TurnControlReceiver {
  bufferedDeliveries: unknown[];
  handleSessionCommand(command: unknown): Promise<unknown>;
}

interface Eve0308TurnControlReceiverConstructor {
  readonly prototype: Eve0308TurnControlReceiver;
}

describe("session inbox consumer compatibility", () => {
  it("loads the published eve 0.30.8 turn receiver and accepts its native send shape", async () => {
    const receiver = await createEve0308TurnControlReceiver();

    await expect(
      receiver.handleSessionCommand({ kind: "send", payload: { message: "follow-up" } }),
    ).resolves.toBeUndefined();
    expect(receiver.bufferedDeliveries).toEqual([expectedDelivery]);
  });

  it("keeps the frozen v0 send shape readable by the published eve 0.30.8 turn receiver", async () => {
    const receiver = await createEve0308TurnControlReceiver();
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { message: "follow-up" } },
      { variant: "send", version: 0 },
    );

    await expect(receiver.handleSessionCommand(wire)).resolves.toBeUndefined();
    expect(receiver.bufferedDeliveries).toEqual([expectedDelivery]);
  });

  it("accepts the current stable envelope with the published eve 0.30.8 receiver", async () => {
    const receiver = await createEve0308TurnControlReceiver();
    const wire = sessionInboxWire.encodeCompatible(
      { kind: "send", payload: { message: "follow-up" } },
      "send",
    );
    await expect(receiver.handleSessionCommand(wire)).resolves.toBeUndefined();
    expect(receiver.bufferedDeliveries).toEqual([expectedDelivery]);
  });

  it("reproduces the failure when a v1 delivery is sent to the published eve 0.30.8 turn receiver", async () => {
    const receiver = await createEve0308TurnControlReceiver();
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { message: "follow-up" } },
      { version: 1 },
    );

    await expect(receiver.handleSessionCommand(wire)).rejects.toThrow(
      /Unsupported session command:.*deliver/,
    );
    expect(receiver.bufferedDeliveries).toEqual([]);
  });
});

const expectedDelivery = {
  auth: undefined,
  caller: undefined,
  kind: "deliver",
  payloads: [{ message: "follow-up" }],
  requestId: undefined,
};

async function createEve0308TurnControlReceiver(): Promise<Eve0308TurnControlReceiver> {
  const packageEntry = import.meta.resolve("historical-eve-0-30-8");
  const receiverModuleUrl = new URL("./execution/turn-control-receiver.js", packageEntry);
  const receiverModule = (await import(receiverModuleUrl.href)) as {
    readonly TurnControlReceiver: Eve0308TurnControlReceiverConstructor;
  };
  // The decoder is the compatibility boundary. Bypass construction so loading
  // the published method does not also require a live 0.30.8 Workflow world.
  const receiver = Object.create(
    receiverModule.TurnControlReceiver.prototype,
  ) as Eve0308TurnControlReceiver;
  receiver.bufferedDeliveries = [];
  return receiver;
}
