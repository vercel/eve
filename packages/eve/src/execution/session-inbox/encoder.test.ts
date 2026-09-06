import { describe, expect, it } from "vitest";
import { sessionInboxWire } from "#execution/session-inbox/encoder.js";
import { sessionInboxWire as decoder } from "#execution/wire/session-inbox-wire.js";
import { SESSION_INBOX_WIRE_VERSIONS } from "#execution/wire/session-inbox-contract.js";

const agentRequest = {
  taskId: "task-1",
  replyTo: "agent-reply",
  request: {
    kind: "agent-invoke" as const,
    invocationId: "call-1",
    input: { message: "Find it", target: "research" },
  },
};

describe("session inbox compatibility", () => {
  it.each(SESSION_INBOX_WIRE_VERSIONS)("preserves hello for a v%i parent", (version) => {
    const wire = sessionInboxWire.encode(
      { kind: "send", payload: { message: "hello" } },
      { version },
    );
    expect(wire).toMatchObject({ kind: "deliver", version, payloads: [{ message: "hello" }] });
    expect(decoder.decode(wire)).toMatchObject({
      kind: "deliver",
      payloads: [{ message: "hello" }],
    });
  });

  it.each([0, 1, 2, 3] as const)(
    "rejects agent requests for v%i at the encoder itself",
    (version) => {
      const command = {
        kind: "send" as const,
        payload: { task: { agentRequests: [agentRequest] } },
      };
      expect(() =>
        sessionInboxWire.encode(
          command,
          version === 0 ? { version, variant: "send" } : { version },
        ),
      ).toThrow(`wire version ${version}`);
    },
  );

  it.each([4, 5, 6] as const)("delivers the complete agent request to v%i", (version) => {
    const payload = { task: { agentRequests: [agentRequest] } };
    const wire = sessionInboxWire.encode({ kind: "send", payload }, { version });
    expect(wire).toMatchObject({ version, payload, payloads: [payload] });
  });

  it.each(["send", "deliver"] as const)(
    "rejects unsupported task operations for legacy %s",
    (variant) => {
      expect(() =>
        sessionInboxWire.encode(
          { kind: "send", payload: { task: { futureOperation: {} } } } as never,
          { version: 0, variant },
        ),
      ).toThrow();
    },
  );

  it("preserves optional accepted-deployment provenance on the stable fast path", () => {
    const delivery = {
      acceptedDeploymentId: "dpl_1",
      deliveryId: "delivery-1",
      channelName: "slack",
      channelKind: "channel:slack",
    };
    expect(
      sessionInboxWire.encode(
        { kind: "send", delivery, payload: { message: "hello" } },
        { version: 0, variant: "send" },
      ),
    ).toMatchObject({ kind: "send", delivery, payload: { message: "hello" } });
  });

  it("does not treat an invalid v5 cancellation as a valid v6 operation", () => {
    expect(() => decoder.decode({ version: 5, kind: "cancel", tasks: true })).toThrow(
      "does not match wire version 5",
    );
  });

  it.each([0, 1, 2, 3, 4, 5] as const)(
    "never removes the meaning of tasks:true for v%i",
    (version) => {
      expect(() =>
        sessionInboxWire.encode(
          { kind: "cancel", tasks: true },
          version === 0 ? { version, variant: "send" } : { version },
        ),
      ).toThrow(`wire version ${version}`);
    },
  );
});

it("keeps new legacy sends readable by the published eve 0.30.8 receiver", async () => {
  const entry = import.meta.resolve("historical-eve-0-30-8");
  const { TurnControlReceiver } = await import(
    new URL("./execution/turn-control-receiver.js", entry).href
  );
  const receiver = Object.create(TurnControlReceiver.prototype);
  receiver.bufferedDeliveries = [];
  const wire = sessionInboxWire.encode(
    { kind: "send", payload: { message: "hello" } },
    { version: 0, variant: "send" },
  );
  await receiver.handleSessionCommand(wire);
  expect(receiver.bufferedDeliveries).toMatchObject([
    { kind: "deliver", payloads: [{ message: "hello" }] },
  ]);
});

it("still reads already-persisted unversioned agent requests from historical writers", () => {
  const payload = { task: { agentRequests: [agentRequest] } };
  expect(decoder.decode({ kind: "send", payload })).toMatchObject({
    kind: "deliver",
    payloads: [payload],
  });
});
