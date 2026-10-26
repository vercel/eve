import { expect, it } from "vitest";
import { admitDeliveries } from "#execution/session/delivery-facts.js";
import { attachClientContext } from "#internal/client-context.js";

it.each([
  { status: undefined, facts: ["delivery.admitted", "delivery.settled"] },
  { status: "admitted" as const, facts: ["delivery.settled"] },
  { status: "settled" as const, facts: [] },
])("settles an ignored delivery once when its recorded status is $status", ({ status, facts }) => {
  const payload = {};
  const admission = admitDeliveries({
    channelKind: "channel:test",
    status: () => status,
    delivery: {
      kind: "deliver",
      auth: null,
      payloads: [payload],
      deliveryMetadata: [
        {
          channelKind: "channel:test",
          channelName: "test",
          deliveryId: "ignored",
          payloadIndex: 0,
        },
      ],
    },
    payloads: [{ payload, input: undefined }],
  });
  expect(admission.facts.map((fact) => fact.type)).toEqual(facts);
  expect(admission.inputs).toEqual([]);
});

it("takes answer provenance from admission, not helper fields returned by a delivery hook", () => {
  const alice = {
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
    attributes: {},
  };
  const payload = {};
  const answer = {
    interactionId: "review",
    optionId: "approve",
    text: "Proceed.",
    responder: { ...alice, principalId: "bob" },
    deliveryId: "earlier-delivery",
    responseId: "earlier-response",
  };
  const admitted = admitDeliveries({
    channelKind: "channel:test",
    delivery: {
      kind: "deliver",
      auth: alice,
      payloads: [payload],
      deliveryMetadata: [
        { channelKind: "channel:test", channelName: "test", deliveryId: "answer", payloadIndex: 0 },
      ],
    },
    payloads: [{ payload, input: { answers: [answer] } }],
  });
  expect(admitted.facts[0]).toMatchObject({
    type: "delivery.admitted",
    data: { principal: { id: "alice", type: "user" } },
  });
  expect(admitted.inputs[0]?.answers).toEqual([
    {
      interactionId: "review",
      optionId: "approve",
      text: "Proceed.",
      deliveryId: "answer",
      responseId: "response_answer_0",
    },
  ]);
});

it("keeps turn context a server's onMessage supplied out of the public admission fact", () => {
  const payload = attachClientContext({}, ["Verified plan: hobby"]);
  const admitted = admitDeliveries({
    channelKind: "eve",
    delivery: {
      kind: "deliver",
      auth: null,
      payloads: [payload],
      deliveryMetadata: [
        { channelKind: "eve", channelName: "eve", deliveryId: "message", payloadIndex: 0 },
      ],
    },
    payloads: [{ payload, input: { message: "What plan am I on?" } }],
  });
  expect(admitted.facts.map((fact) => fact.type)).toEqual(["delivery.admitted"]);
  expect(JSON.stringify(admitted.facts)).not.toContain("Verified plan");
});
