import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { sessions } from "#public/server/index.js";

const dispatchWorkflowSessionCommandMock = vi.fn();
const prewarmWorkflowSessionMock = vi.fn();
const readSessionEventHistoryMock = vi.fn();
const getWorldMock = vi.fn();

vi.mock("#execution/workflow-runtime.js", () => ({
  dispatchWorkflowSessionCommand: (...args: unknown[]) =>
    dispatchWorkflowSessionCommandMock(...args),
}));
vi.mock("#execution/session-prewarm.js", () => ({
  prewarmWorkflowSession: (...args: unknown[]) => prewarmWorkflowSessionMock(...args),
}));
vi.mock("#execution/session-event-stream.js", () => ({
  readSessionEventHistory: (...args: unknown[]) => readSessionEventHistoryMock(...args),
  streamSessionEvents: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: () => getWorldMock(),
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  dispatchWorkflowSessionCommandMock.mockReset();
  prewarmWorkflowSessionMock.mockReset();
  readSessionEventHistoryMock.mockReset();
  getWorldMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("eve/server sessions.end()", () => {
  it("dispatches a reset command with auth and reason and returns a delivery over recorded history", async () => {
    const auth = {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    };
    let capturedDeliveryId = "";
    dispatchWorkflowSessionCommandMock.mockImplementation(async (input) => {
      capturedDeliveryId = input.command.deliveryId;
      return { previousSessionId: "wrun_session_1", status: "reset" };
    });
    readSessionEventHistoryMock.mockImplementation(() => {
      const events: SessionStreamEvent[] = [
        {
          data: { deliveryId: capturedDeliveryId },
          meta: { at: "2026-11-23T00:00:00.000Z", position: { index: 0, line: 1 } },
          type: "delivery.admitted",
        },
        {
          data: { deliveryId: capturedDeliveryId, outcome: "applied" },
          meta: { at: "2026-11-23T00:00:00.000Z", position: { index: 1, line: 1 } },
          type: "delivery.settled",
        },
        {
          data: { cause: { deliveryId: capturedDeliveryId }, outcome: "completed" },
          meta: { at: "2026-11-23T00:00:00.000Z", position: { index: 2, line: 1 } },
          type: "session.ended",
        },
      ];
      return new ReadableStream<SessionStreamEvent>({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        },
      });
    });

    const delivery = await sessions.end("wrun_session_1", { auth, reason: "scheduled sweep" });

    expect(dispatchWorkflowSessionCommandMock).toHaveBeenCalledWith({
      command: {
        auth,
        deliveryId: capturedDeliveryId,
        kind: "reset",
        reason: "scheduled sweep",
      },
      sessionId: "wrun_session_1",
    });
    expect(delivery.sessionId).toBe("wrun_session_1");
    expect(delivery.deliveryId).toBe(capturedDeliveryId);
    const result = await delivery.result();
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("wrun_session_1");
    expect(result.deliveryId).toBe(capturedDeliveryId);
    expect(readSessionEventHistoryMock).toHaveBeenCalledWith(
      "wrun_session_1",
      undefined,
      undefined,
    );
  });

  it("throws SessionNotActiveError when the session is not active", async () => {
    dispatchWorkflowSessionCommandMock.mockResolvedValue({ status: "no_active_session" });

    await expect(sessions.end("wrun_inactive")).rejects.toBeInstanceOf(SessionNotActiveError);
  });
});

describe("eve/server sessions.prewarm()", () => {
  it("passes trimmed VERCEL_DEPLOYMENT_ID to prewarmWorkflowSession without calling getWorld()", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "  dpl_current  ");
    prewarmWorkflowSessionMock.mockResolvedValue({ status: "accepted" });

    await expect(sessions.prewarm("wrun_session_1")).resolves.toEqual({ status: "accepted" });
    expect(prewarmWorkflowSessionMock).toHaveBeenCalledWith("wrun_session_1", "dpl_current");
    expect(getWorldMock).not.toHaveBeenCalled();
  });

  it("falls back to the world deployment id when the world supports deployment affinity", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    getWorldMock.mockResolvedValue({
      capabilities: { deploymentAffinity: true },
      getDeploymentId: vi.fn().mockResolvedValue("dpl_world"),
    });
    prewarmWorkflowSessionMock.mockResolvedValue({ status: "accepted" });

    await expect(sessions.prewarm("wrun_session_1")).resolves.toEqual({ status: "accepted" });
    expect(prewarmWorkflowSessionMock).toHaveBeenCalledWith("wrun_session_1", "dpl_world");
  });

  it("passes undefined deployment id when the world has no deployment affinity", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    getWorldMock.mockResolvedValue({
      capabilities: { deploymentAffinity: false },
      getDeploymentId: vi.fn().mockResolvedValue("dpl_local"),
    });
    prewarmWorkflowSessionMock.mockResolvedValue({ status: "unsupported" });

    await expect(sessions.prewarm("wrun_session_1")).resolves.toEqual({ status: "unsupported" });
    expect(prewarmWorkflowSessionMock).toHaveBeenCalledWith("wrun_session_1", undefined);
  });
});
