import type { Fact, SessionView, TurnSettled } from "eve/events";
import type * as Evlog from "evlog";
import type { DrainContext, WideEvent } from "evlog";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";

// The hook initializes evlog for production on first use; keep the test's
// drain by leaving that call inert at evlog's boundary.
vi.mock("evlog", async (importOriginal) => ({
  ...(await importOriginal<typeof Evlog>()),
  initLogger: vi.fn<typeof Evlog.initLogger>(),
}));

import evlogHook from "@agent/hooks/evlog";

const capturedEvents: WideEvent[] = [];

beforeAll(async () => {
  const { initLogger } = await vi.importActual<typeof Evlog>("evlog");
  initLogger({
    drain({ event }: DrainContext) {
      capturedEvents.push(structuredClone(event));
    },
    env: { service: "open-instinct-test" },
    redact: false,
    silent: true,
  });
});

beforeEach(() => {
  capturedEvents.length = 0;
});

describe("evlog hook", () => {
  it("emits full messages per turn and isolates later turns", async () => {
    const turnFacts = [
      ...turnLines("turn-1", null, {
        received: "email mason@example.com card 4111111111111111",
        response: "full response mason@example.com",
        tool: "web_search",
      }),
      ...turnLines("turn-2", "turn-1", {
        received: "next turn",
        response: "next response",
      }),
    ];
    const view = viewOf(
      turnFacts.map(({ facts }) => facts).filter((facts) => facts.length > 0)
    );

    await emitTurn(turnFacts[3]?.settled, view);
    await emitTurn(turnFacts[7]?.settled, view);

    expect(capturedEvents).toHaveLength(2);
    expect(capturedEvents[0]).toMatchObject({
      agent: { name: "root" },
      channel: { kind: "linq" },
      message: {
        received: "email mason@example.com card 4111111111111111",
        response: "full response mason@example.com",
      },
      requestId: "session-1:turn-1",
      session: { id: "session-1" },
      tools: [{ name: "web_search", outcome: "completed" }],
      turn: { id: "turn-1", outcome: "completed" },
    });
    expect(capturedEvents[1]).toMatchObject({
      message: { received: "next turn", response: "next response" },
      requestId: "session-1:turn-2",
      tools: [],
      turn: { id: "turn-2", outcome: "completed" },
    });
  });

  it("emits one session event when the session ends", async () => {
    const turnFacts = turnLines("turn-1", null, {
      received: "hello",
      response: "hi",
    });
    const view = viewOf(
      turnFacts.map(({ facts }) => facts).filter((facts) => facts.length > 0)
    );

    await evlogHook.events["session.ended"]?.(
      {
        data: {
          error: { code: "session_error", message: "Session crashed." },
          outcome: "failed",
        },
        type: "session.ended",
      },
      contextFor(view)
    );

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({
      requestId: "session-1",
      session: { id: "session-1", outcome: "failed", turns: 1 },
    });
  });
});

function contextFor(view: SessionView) {
  return hookContextFor({
    agentName: "root",
    channel: { kind: "channel:linq", metadata: {} },
    sessionId: "session-1",
    view,
  });
}

async function emitTurn(event: TurnSettled | undefined, view: SessionView) {
  const handler = evlogHook.events["turn.settled"];
  if (!handler || !event) throw new Error("Evlog turn handler is missing.");
  await handler(event, contextFor(view));
}

/** One stored line per entry; the last entry carries the turn's settlement. */
function turnLines(
  turnId: string,
  follows: string | null,
  {
    received,
    response,
    tool,
  }: { received: string; response: string; tool?: string }
): { facts: Fact[]; settled?: TurnSettled }[] {
  const runId = `run-${turnId}`;
  const callId = `call-${turnId}`;
  const partId = `part-${turnId}`;
  const settled: TurnSettled = {
    data: { outcome: "completed", reply: [partId], turnId },
    scope: { turnId },
    type: "turn.settled",
  };
  return [
    {
      facts: [
        {
          data: { deliveryId: `delivery-${turnId}` },
          type: "delivery.admitted",
        },
        {
          data: {
            cause: { deliveryId: `delivery-${turnId}` },
            follows,
            turnId,
          },
          scope: { turnId },
          type: "turn.started",
        },
        {
          data: {
            deliveryId: `delivery-${turnId}`,
            parts: [{ kind: "text", text: received }],
            turnId,
          },
          scope: { turnId },
          type: "delivery.consumed",
        },
        {
          data: { owner: { turnId }, runId },
          scope: { runId, turnId },
          type: "model.requested",
        },
      ],
    },
    {
      facts: tool
        ? [
            {
              data: {
                callId,
                capability: { kind: "tool", name: tool },
                input: {},
                owner: { runId },
              },
              scope: { runId, turnId },
              type: "call.requested",
            },
            {
              data: { callId, outcome: "completed", output: {} },
              scope: { runId, turnId },
              type: "call.settled",
            },
          ]
        : [],
    },
    {
      facts: [
        {
          data: {
            kind: "text",
            partId,
            phase: "reply",
            runId,
            value: response,
          },
          scope: { runId, turnId },
          type: "content.completed",
        },
      ],
    },
    { facts: [settled], settled },
  ];
}
