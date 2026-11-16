import type { Fact, SessionView, TurnSettled } from "eve/events";
import type * as Evlog from "evlog";
import { initLogger, type DrainContext, type WideEvent } from "evlog";
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
  const { initLogger: initializeTestLogger } =
    await vi.importActual<typeof Evlog>("evlog");
  initializeTestLogger({
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
  it("emits per-turn metadata without private conversation text", async () => {
    const turnFacts = [
      ...turnLines("turn-1", null, {
        received: "Alice lives at 24 Ordinary Street, email alice@example.com",
        response: "I saved Alice's address at 24 Ordinary Street",
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
      message: { receivedCount: 1, responsePartCount: 1 },
      requestId: "session-1:turn-1",
      session: { id: "session-1" },
      tools: [{ name: "web_search", outcome: "completed" }],
      turn: { id: "turn-1", outcome: "completed" },
    });
    expect(capturedEvents[1]).toMatchObject({
      message: { receivedCount: 1, responsePartCount: 1 },
      requestId: "session-1:turn-2",
      tools: [],
      turn: { id: "turn-2", outcome: "completed" },
    });
    expect(initLogger).toHaveBeenCalledWith({
      env: { service: "open-instinct" },
      redact: true,
    });
    const serialized = JSON.stringify(capturedEvents);
    for (const text of [
      "Alice",
      "24 Ordinary Street",
      "alice@example.com",
      "next turn",
      "next response",
    ]) {
      expect(serialized).not.toContain(text);
    }
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
          error: {
            code: "session_error",
            message: "Alice's private session error",
          },
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
    expect(JSON.stringify(capturedEvents)).not.toContain("Alice");
  });

  it("omits private turn errors and telemetry failures", async () => {
    const facts = turnLines("turn-1", null, {
      received: "hello",
      response: "hi",
    });
    const view = viewOf(
      facts
        .map(({ facts: entries }) => entries)
        .filter((entries) => entries.length > 0)
    );
    const settled = facts[3]?.settled;
    if (!settled) throw new Error("Missing settlement");
    const failed: TurnSettled = {
      ...settled,
      data: {
        ...settled.data,
        outcome: "failed",
        error: { code: "private", message: "Alice's private error" },
      },
    };
    await emitTurn(failed, view);
    expect(JSON.stringify(capturedEvents)).not.toContain("Alice");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const ctx = contextFor(view);
      Object.defineProperty(ctx, "agent", {
        get() {
          throw new Error("Alice's private telemetry error");
        },
      });
      await evlogHook.events["turn.settled"]?.(failed, ctx);
      expect(warn).toHaveBeenCalledWith("[evlog] turn event failed");
    } finally {
      warn.mockRestore();
    }
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
