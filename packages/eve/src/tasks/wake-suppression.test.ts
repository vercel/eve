import { describe, expect, it } from "vitest";

import type { DeliverPayload } from "#channel/types.js";
import type { HarnessSession } from "#harness/types.js";
import {
  clearAwaitedTaskWakeSuppressions,
  consumeAwaitedTaskWakes,
  suppressAwaitedTaskWakes,
} from "#tasks/wake-suppression.js";

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_parent",
    history: [],
    sessionId: "session_parent",
  };
}

const taskWake: DeliverPayload = {
  message: "Background task task_1 is completed.",
  taskNotification: { status: "completed", taskId: "task_1" },
};

describe("task wake suppression", () => {
  it("drops the wake claimed by task_await", () => {
    const session = suppressAwaitedTaskWakes(createSession(), ["task_1"]);

    const consumed = consumeAwaitedTaskWakes(session, [taskWake]);

    expect(consumed.payloads).toEqual([]);
  });

  it("keeps the wake after a cancelled await releases its claim", () => {
    const session = clearAwaitedTaskWakeSuppressions(
      suppressAwaitedTaskWakes(createSession(), ["task_1"]),
    );

    const consumed = consumeAwaitedTaskWakes(session, [taskWake]);

    expect(consumed.payloads).toEqual([taskWake]);
  });

  it("leaves unrelated deliveries and their later suppression intact", () => {
    const session = suppressAwaitedTaskWakes(createSession(), ["task_1"]);
    const unrelated = { message: "hello" };

    const first = consumeAwaitedTaskWakes(session, [unrelated]);
    const second = consumeAwaitedTaskWakes(first.session, [taskWake]);

    expect(first.payloads).toEqual([unrelated]);
    expect(second.payloads).toEqual([]);
  });
});
