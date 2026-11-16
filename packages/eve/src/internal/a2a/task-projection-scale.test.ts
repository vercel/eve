import { describe, expect, it } from "vitest";

import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { DeliveryRow, SessionView, TurnRow } from "#protocol/session-projection/tables.js";

import { deliveryIdForMessage } from "./ids.js";
import { contextBusy, contextTasks, projectTask } from "./task-projection.js";

const AT = "2026-01-01T00:00:00.000Z";

/** A context with `count` finished tasks, each one delivery and one completed turn. */
function contextWith(count: number): SessionView {
  const view = emptySessionView();
  const deliveries = view.deliveries as Record<string, DeliveryRow>;
  const turns = view.turns as Record<string, TurnRow>;
  for (let i = 0; i < count; i += 1) {
    const deliveryId = deliveryIdForMessage(`m-${i}`);
    deliveries[deliveryId] = {
      deliveryId,
      endedAt: AT,
      introducedAt: 2 * i,
      parts: [{ kind: "text", text: `task ${i}` }],
      startedAt: AT,
      status: "settled",
      turnId: `turn_${i}`,
    } as DeliveryRow;
    turns[`turn_${i}`] = {
      endedAt: AT,
      introducedAt: 2 * i + 1,
      outcome: "completed",
      startedAt: AT,
      status: "settled",
      turnId: `turn_${i}`,
    } as TurnRow;
  }
  return view;
}

describe("projecting a long context", () => {
  it("lists every task in time linear in the session, not quadratic", () => {
    const view = contextWith(3_000);
    const started = performance.now();
    // With history, as a ListTasks that asks for it projects each task.
    const tasks = contextTasks(view, "wrun_1");
    expect(contextBusy(view, "wrun_1")).toBe(false);
    const elapsed = performance.now() - started;
    expect(tasks).toHaveLength(3_000);
    // A scan of the session per task takes seconds here; the index keeps it far below that.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("still gives a listed task its own history", () => {
    const view = contextWith(3);
    const [first] = contextTasks(view, "wrun_1", { historyLength: 0 });
    const full = projectTask(view, first!.ref);
    expect(full.history?.map((message) => message.parts[0]?.text)).toEqual([
      expect.stringMatching(/^task \d$/u),
    ]);
  });
});
