import { beforeEach, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const ports = vi.hoisted(() => ({ getWorld: vi.fn(), streamSessionEvents: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: ports.getWorld }));
vi.mock("#execution/session-event-stream.js", () => ({
  streamSessionEvents: ports.streamSessionEvents,
}));

import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";

beforeEach(() => vi.resetAllMocks());

it.each(["cancelled", "failed"] as const)(
  "does not turn a %s request into success when its session retires normally",
  async (outcome) => {
    const auth: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    ports.getWorld.mockResolvedValue({
      runs: {
        get: async () => ({
          runId: "invocation-1",
          createdAt: new Date("2026-10-16T00:00:00.000Z"),
          status: "completed",
          attributes: {
            [INVOCATION_OWNER_ATTRIBUTE]: invocationOwnerKey(auth),
            [INVOCATION_TOKEN_ATTRIBUTE]: "invocation-token",
          },
        }),
      },
    });
    const facts: SessionEvent[] = [
      {
        type: "turn.started",
        data: { turnId: "turn-1", follows: null, cause: { deliveryId: "delivery-1" } },
      },
      {
        type: "turn.settled",
        data: {
          turnId: "turn-1",
          outcome,
          error:
            outcome === "failed"
              ? { code: "RELEASE_FAILED", message: "Release failed." }
              : undefined,
        },
      },
      { type: "session.ended", data: { outcome: "completed" } },
    ];
    ports.streamSessionEvents.mockImplementation(async function* () {
      for (const [line, fact] of facts.entries())
        yield {
          ...fact,
          meta: { at: "2026-10-16T00:00:00.000Z", position: { line, index: 0 }, endOfLine: true },
        } as SessionStreamEvent;
    });
    const execution = new WorkflowAgentInvocationExecution({
      createSession: async () => {
        throw new Error("Creation is not used by reads");
      },
      from: () => {
        throw new Error("Dispatch is not used by reads");
      },
    });
    expect(await execution.read({ invocationId: "invocation-1", auth })).toMatchObject({
      status: outcome,
      sessionEnded: true,
    });
  },
);
