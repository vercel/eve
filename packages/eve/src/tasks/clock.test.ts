import { describe, expect, it } from "vitest";

import type { SessionStateMap } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { InputRequest } from "#shared/input.js";
import { resumeResolvedTaskClocks, stopTaskClock } from "#tasks/clock.js";
import { getTaskTable } from "#tasks/state.js";

const STOPPED = "2026-09-24T13:00:00.000Z";
const RESUMED = "2026-09-24T13:30:00.000Z";
const request: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
  kind: "question",
  prompt: "Ship it?",
  requestId: "request-1",
};

describe("task clock", () => {
  it("stops a task's clock while its request waits and extends the deadline once it resolves", () => {
    const working = createTaskRecord({ deadlineAt: "2026-09-24T14:00:00.000Z" });
    const stopped = stopTaskClock(
      { state: taskTableState([working]) },
      { now: STOPPED, requests: [request], taskId: working.id },
    );
    expect(getTaskTable(stopped).records[0]).toMatchObject({
      clockStoppedAt: STOPPED,
      inputSeq: 0,
      status: "input_required",
    });

    // The route is still pending, so the clock stays stopped.
    const pending = withRoutes(stopped.state, { "request-1": working.id });
    expect(resumeResolvedTaskClocks({ state: pending }, RESUMED).state).toBe(pending);

    const resumed = resumeResolvedTaskClocks({ state: withRoutes(stopped.state, {}) }, RESUMED);
    expect(getTaskTable(resumed).records[0]).toMatchObject({
      deadlineAt: "2026-09-24T14:30:00.000Z",
      inputSeq: 1,
      status: "working",
    });
    expect(getTaskTable(resumed).records[0]).not.toHaveProperty("clockStoppedAt");
  });

  it("keeps waiting while another of the task's requests remains", () => {
    const working = createTaskRecord({ deadlineAt: "2026-09-24T14:00:00.000Z" });
    const stopped = stopTaskClock(
      { state: taskTableState([working]) },
      {
        now: STOPPED,
        requests: [request, { ...request, requestId: "request-2" }],
        taskId: working.id,
      },
    );

    const partlyAnswered = resumeResolvedTaskClocks(
      { state: withRoutes(stopped.state, { "request-2": working.id }) },
      RESUMED,
    );

    expect(getTaskTable(partlyAnswered).records[0]).toMatchObject({
      clockStoppedAt: STOPPED,
      status: "input_required",
    });
  });

  it("ignores a finished task", () => {
    const finished = createTaskRecord({ delivered: false, status: "completed" });
    const session = { state: taskTableState([finished]) };

    expect(stopTaskClock(session, { now: STOPPED, requests: [request], taskId: finished.id })).toBe(
      session,
    );
  });
});

function withRoutes(
  state: SessionStateMap | undefined,
  routes: Readonly<Record<string, string>>,
): SessionStateMap {
  return {
    ...state,
    "eve.runtime.proxyInputRequests": Object.fromEntries(
      Object.entries(routes).map(([requestId, taskId]) => [
        requestId,
        { childContinuationToken: "child-token", kind: "question", taskId },
      ]),
    ),
  };
}
