import { describe, expect, it } from "vitest";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
import { sessionInboxWire as current } from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWire as v1 } from "#internal/testing/v1-session-inbox-wire.js";
import { sessionInboxWire as v5 } from "#internal/testing/v5-session-inbox-wire.js";

const caller = {
  activityObserver: { sink: { url: "https://example.com/activity", version: 1 as const } },
  callId: "call-1",
  replyTo: { kind: "hook" as const, token: "reply" },
  subagentName: "research",
};
const payload = {
  message: "hello",
  context: ["saved conversation context"],
  inputResponses: [{ requestId: "request-1", text: "approved" }],
  task: {
    inputRequests: [
      {
        replyTo: "answer",
        request: { prompt: "Continue?", requestId: "ask-1" },
        sequence: 1,
        stepIndex: 2,
        taskId: "task-1",
        turnId: "turn-1",
      },
    ],
    agentRequests: [
      {
        replyTo: "agent-reply",
        taskId: "task-1",
        request: {
          kind: "agent-invoke" as const,
          invocationId: "invoke-1",
          input: { target: "research", message: "find it" },
        },
      },
    ],
  },
};

describe.each([
  ["v1", v1],
  ["v5", v5],
  ["current", current],
] as const)("compatible inbox with %s parent", (_name, receiver) => {
  it.each(["send", "deliver"] as const)(
    "forwards current contents in the stable %s envelope",
    (variant) => {
      const wire = sessionInboxWire.encodeCompatible(
        {
          kind: "send",
          payload,
          caller,
          requestId: "req-1",
          taskDeliveryId: "task-1:ready",
          turnPolicy: "queue",
        },
        variant,
      );
      expect(wire).not.toHaveProperty("version");
      expect(receiver.decode(wire)).toMatchObject({
        caller,
        kind: "deliver",
        payloads: [payload],
        requestId: "req-1",
        taskDeliveryId: "task-1:ready",
        turnPolicy: "queue",
      });
    },
  );

  it("preserves batched payloads and their accepted deployment routing", () => {
    const deliveryMetadata = [0, 1].map((payloadIndex) => ({
      acceptedDeploymentId: "dpl_latest",
      channelKind: "channel:http",
      channelName: "http",
      deliveryId: `delivery-${payloadIndex}`,
      payloadIndex,
    }));
    const command = {
      caller,
      deliveryMetadata,
      kind: "deliver" as const,
      payloads: [
        { message: "first" },
        { inputResponses: [{ requestId: "request-1", text: "yes" }] },
      ],
    };
    expect(receiver.decode(sessionInboxWire.encodeCompatible(command, "deliver"))).toMatchObject(
      command,
    );
  });

  it.each([
    { kind: "cancel", turnId: "turn-1" },
    { kind: "clear" },
    { kind: "compact" },
    { kind: "reset", reason: "new conversation" },
    { kind: "session-timeout" },
  ] as const)("preserves the existing $kind control", (command) => {
    expect(receiver.decode(sessionInboxWire.encodeCompatible(command, "deliver"))).toMatchObject(
      command,
    );
  });
});

it("avoids the v5 rejection caused solely by the sender's version stamp", () => {
  const command = { kind: "send" as const, payload: { message: "hello" } };
  expect(() => v5.decode(sessionInboxWire.encode(command, { version: 6 }))).toThrow(
    /newer than the supported version 5/,
  );
  expect(v5.decode(sessionInboxWire.encodeCompatible(command, "deliver"))).toMatchObject({
    kind: "deliver",
    payloads: [command.payload],
  });
});

it("keeps validation at the sender", () => {
  expect(() =>
    sessionInboxWire.encodeCompatible(
      { kind: "send", payload: { inputResponses: [{ requestId: 42 }] } } as never,
      "deliver",
    ),
  ).toThrow(/does not match wire/);
});

it("does not disguise unsupported parent-owned task cancellation as an old control", () => {
  expect(() =>
    sessionInboxWire.encodeCompatible({ kind: "cancel", tasks: true }, "deliver"),
  ).toThrow(/requires a capable parent/);
  expect(() => sessionInboxWire.encode({ kind: "cancel", tasks: true }, { version: 5 })).toThrow(
    /Cannot encode session-owned task cancellation/,
  );
});

it("retains legacy capability negotiation for older producers with caller observers", () => {
  const command = { kind: "send" as const, payload: { message: "hello" }, caller };
  const stamped = sessionInboxWire.encode(command, { version: 6 });
  expect(current.decode(stamped)).toMatchObject({ caller, payloads: [command.payload] });
  // Removing the alias stamp would make existing producers choose this lossy projection.
  const markerless = sessionInboxWire.encode(command, { variant: "send", version: 0 });
  expect(current.decode(markerless)).not.toHaveProperty("caller.activityObserver");
});
