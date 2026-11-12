import { describe, expect, it, vi } from "vitest";

import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { DeliveryRow, SessionView, TurnRow } from "#protocol/session-projection/tables.js";

vi.mock("#protocol/session-projection/selectors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#protocol/session-projection/selectors.js")>()),
  activity: () => ({ kind: "calling", names: ["lookup_orders"] }),
}));

const { failureText, projectTask } = await import("./task-projection.js");

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const ref = { deliveryId: "first", sessionId: "wrun_1" };

function viewWithTurn(turn: Partial<TurnRow>): SessionView {
  const view = emptySessionView();
  (view.deliveries as Record<string, DeliveryRow>).first = {
    deliveryId: "first",
    introducedAt: 0,
    startedAt: STARTED_AT,
    status: "consumed",
    turnId: "turn_0",
  } as DeliveryRow;
  (view.turns as Record<string, TurnRow>).turn_0 = {
    introducedAt: 1,
    startedAt: STARTED_AT,
    status: "running",
    turnId: "turn_0",
    ...turn,
  } as TurnRow;
  return view;
}

function statusText(task: ReturnType<typeof projectTask>): string | undefined {
  return task.status.message?.parts[0]?.text;
}

describe("projectTask status", () => {
  it("names the running tool in a working status unless toolActivity is off", () => {
    const view = viewWithTurn({});
    const named = projectTask(view, ref);
    expect(named.status.state).toBe("TASK_STATE_WORKING");
    expect(statusText(named)).toBe("lookup_orders");

    const hidden = projectTask(view, ref, { toolActivity: false });
    expect(hidden.status).toEqual({
      state: "TASK_STATE_WORKING",
      timestamp: named.status.timestamp,
    });
  });

  it("keeps a failure's first line and support id, never an HTML page or stack frames", () => {
    const view = viewWithTurn({
      endedAt: STARTED_AT,
      error: {
        code: "MODEL_FAILED",
        id: "err_123",
        message:
          "Provider returned 502 <!DOCTYPE html><html><body>edge-7f internal</body></html>\n" +
          "    at callProvider (/var/task/model.js:10:5)",
      },
      outcome: "failed",
      status: "settled",
    });
    const task = projectTask(view, ref);
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(statusText(task)).toBe("Provider returned 502 (error id: err_123)");
  });
});

describe("failureText", () => {
  it("bounds a long first line and falls back when nothing is left", () => {
    expect(failureText("x".repeat(400))).toHaveLength(300);
    expect(failureText("x".repeat(400)).endsWith("…")).toBe(true);
    expect(failureText("<html><body>Bad gateway</body></html>")).toBe("The task failed.");
    expect(failureText(undefined, "err_1")).toBe("The task failed. (error id: err_1)");
    expect(failureText("Rate limited.\r\nRetry-After: 30")).toBe("Rate limited.");
  });
});
