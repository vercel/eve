import { describe, expect, it } from "vitest";

import { projectActivityEvents } from "#execution/activity-events.js";
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

  it("skips delegated actions and projects safe settlement only", () => {
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
});
