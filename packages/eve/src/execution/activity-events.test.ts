import { describe, expect, it } from "vitest";

import { projectActivityEvents } from "#execution/activity-events.js";
import { deriveChildActivityWorkId } from "#execution/activity-work-id.js";
import { MAX_ACTIVITY_TEXT_LENGTH } from "#execution/activity-text.js";

const lineage = {
  id: "work:root:turn",
  kind: "root-turn" as const,
  rootSessionId: "root",
  rootTurnId: "turn",
};

describe("projectActivityEvents", () => {
  it("projects tools and skills without inputs", () => {
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:00Z",
        event: {
          data: {
            actions: [
              {
                callId: "tool-1",
                input: { secret: "hidden" },
                kind: "tool-call",
                toolName: "search",
              },
              { callId: "skill-1", input: { skill: "private" }, kind: "load-skill" },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "turn",
          },
          type: "actions.requested",
        },
        lineage,
      }),
    ).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({
          id: "action:work:root:turn:tool-1",
          kind: "tool",
          name: "search",
          stepIndex: 0,
        }),
        kind: "action.started",
      }),
      expect.objectContaining({
        action: expect.objectContaining({
          id: "action:work:root:turn:skill-1",
          kind: "skill",
          name: "load_skill",
          stepIndex: 0,
        }),
        kind: "action.started",
      }),
    ]);
  });

  it("normalizes and bounds authorization blocker labels", () => {
    const [event] = projectActivityEvents({
      at: "2026-01-01T00:00:00Z",
      event: {
        data: {
          attemptId: "attempt-1",
          authorization: { displayName: `Sign\u0000 in ${"x".repeat(600)}` },
          description: "Authorize",
          name: "provider",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn",
        },
        type: "authorization.required",
      },
      lineage,
    });

    expect(event?.kind).toBe("blocker.started");
    if (event?.kind !== "blocker.started") return;
    expect(event.blocker.label).not.toContain("\u0000");
    expect(event.blocker.label).toHaveLength(MAX_ACTIVITY_TEXT_LENGTH);
  });

  it("normalizes and bounds input blocker labels", () => {
    const [event] = projectActivityEvents({
      at: "2026-01-01T00:00:00Z",
      event: {
        data: {
          requests: [
            {
              action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "search" },
              kind: "question",
              prompt: `Choose\u0007 ${"y".repeat(600)}`,
              requestId: "request-1",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn",
        },
        type: "input.requested",
      },
      lineage,
    });

    expect(event?.kind).toBe("blocker.started");
    if (event?.kind !== "blocker.started") return;
    expect(event.blocker.label).not.toContain("\u0007");
    expect(event.blocker.label).toHaveLength(MAX_ACTIVITY_TEXT_LENGTH);
  });

  it("projects safe tool settlement", () => {
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:01Z",
        event: {
          data: {
            error: { code: "FAILED", message: "private detail" },
            result: {
              callId: "tool-1",
              isError: true,
              kind: "tool-result",
              output: { secret: "hidden" },
              toolName: "search",
            },
            sequence: 0,
            status: "failed",
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.result",
        },
        lineage,
      }),
    ).toEqual([
      {
        actionId: "action:work:root:turn:tool-1",
        eventId: "action:work:root:turn:tool-1:settled:failed",
        kind: "action.settled",
        outcome: "failed",
        settledAt: "2026-01-01T00:00:01Z",
      },
    ]);
  });

  it("projects accepted task_update results as task work updates", () => {
    const event = {
      data: {
        result: {
          callId: "task-update-1",
          kind: "tool-result" as const,
          output: { message: "Working", status: "sent", taskId: "task-1" },
          toolName: "task_update",
        },
        sequence: 1,
        status: "completed" as const,
        stepIndex: 2,
        turnId: "turn",
      },
      type: "action.result" as const,
    };
    const taskLineage = { ...lineage, id: "work:task", kind: "task" as const };
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:00.000Z",
        event,
        lineage: taskLineage,
        sourceEventId: "event-1",
      }),
    ).toEqual([
      {
        eventId: "event-1",
        kind: "work.updated",
        message: "Working",
        updatedAt: "2026-01-01T00:00:00.000Z",
        workId: "work:task",
      },
      {
        actionId: "action:work:task:task-update-1",
        eventId: "action:work:task:task-update-1:settled:completed",
        kind: "action.settled",
        outcome: "completed",
        settledAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(projectActivityEvents({ at: "2026-01-01T00:00:00.000Z", event, lineage })).toEqual([
      expect.objectContaining({ kind: "action.settled" }),
    ]);
  });

  it("settles delegated work from its parent action result", () => {
    const workId = deriveChildActivityWorkId({
      callId: "child-1",
      parentSessionId: "root",
      parentTurnId: "turn",
    });
    const parentLineage = {
      ...lineage,
      sessionId: "root",
      turnId: "turn",
    };
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:02Z",
        event: {
          data: {
            result: {
              callId: "child-1",
              kind: "subagent-result",
              origin: "child",
              outcome: {
                kind: "terminal",
                result: { kind: "succeeded", output: "done" },
                usageDelta: {
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                },
              },
              output: "done",
              subagentName: "researcher",
            },
            sequence: 0,
            status: "completed",
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.result",
        },
        lineage: parentLineage,
      }),
    ).toEqual([
      {
        eventId: `${workId}:settled:completed`,
        kind: "work.settled",
        outcome: "completed",
        settledAt: "2026-01-01T00:00:02Z",
        workId,
      },
    ]);
  });

  it("keeps delegated work active for a background receipt", () => {
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:02Z",
        event: {
          data: {
            result: {
              backgroundTask: { status: "working", taskId: "task-1" },
              callId: "child-1",
              kind: "subagent-result",
              origin: "child",
              outcome: {
                kind: "parked",
                result: { kind: "succeeded", output: "working" },
                usageDelta: {
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                },
              },
              output: "working",
              subagentName: "researcher",
            },
            sequence: 0,
            status: "completed",
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.result",
        },
        lineage: { ...lineage, sessionId: "root", turnId: "turn" },
      }),
    ).toEqual([]);
  });
});
