import { expect, it } from "vitest";

import { stampTestEvent } from "#internal/testing/events.js";
import { StreamDelivery } from "#client/delivery.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";

function delivery(facts: readonly SessionEvent[]) {
  return new StreamDelivery({
    sessionId: "session_1",
    deliveryId: "delivery_1",
    createStream: async function* () {
      for (const [line, event] of facts.entries())
        yield {
          ...event,
          meta: { at: "2026-10-15T00:00:00.000Z", position: { line, index: 0 } },
        } as SessionStreamEvent;
    },
  });
}

async function eventsOf(stream: AsyncIterable<SessionStreamEvent>) {
  const events: SessionStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

it.each([
  ["handled", "completed", "completed"],
  ["handled", "cancelled", "cancelled"],
  ["awaiting-input", undefined, "awaiting-input"],
  ["applied", "cancelled", "completed"],
  ["ignored", undefined, "completed"],
  ["failed", undefined, "failed"],
  ["refused", undefined, "failed"],
] as const)(
  "reports %s with turn outcome %s as %s",
  async (outcome: DeliveryOutcome, turn: TurnOutcome | undefined, status) => {
    const facts: SessionEvent[] = [
      {
        type: "delivery.admitted",
        data: { deliveryId: "delivery_1", source: { channel: "http" } },
      },
      {
        type: "delivery.consumed",
        data: { deliveryId: "delivery_1", turnId: "turn_1", parts: [] },
      },
    ];
    if (turn !== undefined)
      facts.push({
        type: "turn.settled",
        data: { turnId: "turn_1", outcome: turn },
        scope: { turnId: "turn_1" },
      });
    facts.push({
      type: "delivery.settled",
      data: { deliveryId: "delivery_1", outcome, turnId: "turn_1" },
    });
    const receipt = delivery(facts);
    expect(await receipt.result()).toMatchObject({
      outcome,
      status,
      sessionEnded: false,
      sessionId: "session_1",
      deliveryId: "delivery_1",
    });
  },
);

it("supports repeated, concurrent, and partially consumed reads without retaining events", async () => {
  const facts: SessionEvent[] = [
    { type: "delivery.admitted", data: { deliveryId: "delivery_1" } },
    { type: "delivery.settled", data: { deliveryId: "delivery_1", outcome: "ignored" } },
  ];
  const receipt = delivery(facts);
  for await (const _event of receipt.stream()) break;
  const [events, result] = await Promise.all([eventsOf(receipt.stream()), receipt.result()]);
  expect(events.map(({ type }) => type)).toEqual(["delivery.admitted", "delivery.settled"]);
  expect(await eventsOf(receipt.stream())).toEqual(events);
  expect(await receipt.result()).toEqual(result);
  expect(result).not.toHaveProperty("events");
});

it("isolates aborted reads and does not cache interrupted results", async () => {
  const receipt = delivery([
    { type: "delivery.settled", data: { deliveryId: "delivery_1", outcome: "applied" } },
  ]);
  const controller = new AbortController();
  const reading = receipt.stream({ signal: controller.signal })[Symbol.asyncIterator]();
  await reading.next();
  controller.abort();
  await expect(reading.next()).rejects.toThrow();
  await expect(receipt.result({ signal: controller.signal })).rejects.toThrow();
  await expect(receipt.result()).resolves.toMatchObject({ outcome: "applied" });
});

it("retries an interrupted result instead of caching a rejected read", async () => {
  let attempts = 0;
  const receipt = new StreamDelivery({
    sessionId: "session_1",
    deliveryId: "delivery_1",
    createStream: async function* () {
      yield stampTestEvent({ type: "delivery.admitted", data: { deliveryId: "delivery_1" } });
      if (++attempts === 1) throw new Error("Connection lost.");
      yield stampTestEvent(
        { type: "delivery.settled", data: { deliveryId: "delivery_1", outcome: "applied" } },
        1,
      );
    },
  });
  await expect(receipt.result()).rejects.toThrow("Connection lost.");
  await expect(receipt.result()).resolves.toMatchObject({
    status: "completed",
    outcome: "applied",
  });
});

it("returns actionable errors for failed or refused deliveries without a turn error", async () => {
  const result = await delivery([
    { type: "delivery.settled", data: { deliveryId: "delivery_1", outcome: "refused" } },
  ]).result();
  expect(result).toMatchObject({
    status: "failed",
    outcome: "refused",
    error: { code: "DELIVERY_REFUSED", message: expect.any(String) },
  });
});

it("does not reuse another turn's structured output for a queued request", async () => {
  const receipt = delivery([
    { type: "delivery.admitted", data: { deliveryId: "delivery_1", source: { channel: "http" } } },
    {
      type: "content.completed",
      scope: { turnId: "older_turn" },
      data: {
        runId: "older_run",
        partId: "older_result",
        kind: "result",
        phase: "reply",
        value: { from: "older turn" },
      },
    },
    {
      type: "turn.settled",
      data: { turnId: "older_turn", outcome: "completed", reply: ["older_result"] },
    },
    { type: "delivery.consumed", data: { deliveryId: "delivery_1", turnId: "turn_1", parts: [] } },
    { type: "turn.settled", data: { turnId: "turn_1", outcome: "completed", reply: [] } },
    {
      type: "delivery.settled",
      data: { deliveryId: "delivery_1", turnId: "turn_1", outcome: "handled" },
    },
  ]);
  expect(await receipt.result()).toMatchObject({
    status: "completed",
    reply: undefined,
    data: undefined,
  });
});

it("keeps session termination separate and serializes only receipt properties", async () => {
  const receipt = delivery([
    { type: "delivery.settled", data: { deliveryId: "delivery_1", outcome: "applied" } },
    { type: "session.ended", data: { outcome: "completed" } },
  ]);
  expect(JSON.parse(JSON.stringify(receipt))).toEqual({
    sessionId: "session_1",
    deliveryId: "delivery_1",
  });
  expect(await receipt.result()).toMatchObject({ status: "completed", sessionEnded: true });
});
