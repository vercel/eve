import { describe, expect, it } from "vitest";

import { projectActivityEvents } from "#execution/activity-events.js";
import { deriveChildActivityWorkId } from "#execution/activity-work-id.js";
import { MAX_ACTIVITY_TEXT_LENGTH } from "#shared/presentation-text.js";

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
            presentation: { "tool-1": { label: "Search issues" } },
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
        actionId: "action:work:root:turn:tool-1",
        kind: "action.label.updated",
        label: "Search issues",
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

  it("projects safe tool updates from partial events", () => {
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:01Z",
        event: {
          data: {
            presentation: { "tool-1": { label: "Collecting sources" } },
            result: {
              callId: "tool-1",
              kind: "tool-result",
              output: { secret: "hidden" },
              toolName: "search",
            },
            sequence: 0,
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.partial",
        },
        eventId: "partial-1",
        lineage,
      }),
    ).toEqual([
      {
        actionId: "action:work:root:turn:tool-1",
        eventId: "action:work:root:turn:tool-1:update:partial-1",
        kind: "action.label.updated",
        label: "Collecting sources",
      },
    ]);
  });

  it("projects successful result text before tool settlement", () => {
    expect(
      projectActivityEvents({
        at: "2026-01-01T00:00:02Z",
        event: {
          data: {
            presentation: { "tool-1": { label: "Report ready" } },
            result: {
              callId: "tool-1",
              kind: "tool-result",
              output: { report: "hidden" },
              toolName: "build_report",
            },
            sequence: 0,
            status: "completed",
            stepIndex: 0,
            turnId: "turn",
          },
          type: "action.result",
        },
        eventId: "result-1",
        lineage,
      }),
    ).toEqual([
      {
        actionId: "action:work:root:turn:tool-1",
        eventId: "action:work:root:turn:tool-1:result:result-1",
        kind: "action.label.updated",
        label: "Report ready",
      },
      {
        actionId: "action:work:root:turn:tool-1",
        eventId: "action:work:root:turn:tool-1:settled:completed",
        kind: "action.settled",
        outcome: "completed",
        settledAt: "2026-01-01T00:00:02Z",
      },
    ]);
  });

  it("projects safe failed tool settlement", () => {
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
