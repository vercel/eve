import { describe, expect, it } from "vitest";

import { reduceWorkGraph } from "#harness/work-graph.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

function reduce(...events: readonly UnstampedMessageStreamEvent[]) {
  return events.reduce(reduceWorkGraph, undefined);
}

describe("work graph", () => {
  it("groups incrementally requested actions under their model step", () => {
    const graph = reduce(
      { data: { sequence: 0, turnId: "turn-1" }, type: "turn.started" },
      {
        data: { modelId: "test", sequence: 0, stepIndex: 0, turnId: "turn-1" },
        type: "step.started",
      },
      {
        data: {
          actions: [
            {
              callId: "call-search",
              input: { query: "eve" },
              kind: "tool-call",
              toolName: "search_docs",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "actions.requested",
      },
      {
        data: {
          actions: [
            {
              callId: "call-read",
              input: { path: "docs/slack.md" },
              kind: "tool-call",
              toolName: "read_file",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "actions.requested",
      },
    );

    expect(graph).toEqual({
      revision: 4,
      turn: {
        blockers: [],
        id: "turn-1",
        phase: "running",
        steps: [
          {
            actions: [
              { callId: "call-search", kind: "tool-call", name: "search_docs", phase: "running" },
              { callId: "call-read", kind: "tool-call", name: "read_file", phase: "running" },
            ],
            phase: "running",
            stepIndex: 0,
          },
        ],
      },
    });
  });

  it("attaches a child session and does not let its terminal action resurrect", () => {
    const graph = reduce(
      { data: { sequence: 0, turnId: "turn-1" }, type: "turn.started" },
      {
        data: {
          actions: [
            {
              callId: "call-child",
              description: "Research the issue.",
              input: {},
              kind: "subagent-call",
              name: "researcher",
              nodeId: "subagents/researcher",
              subagentName: "researcher",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "actions.requested",
      },
      {
        data: {
          callId: "call-child",
          childSessionId: "child-1",
          childStreamPath: "/eve/v1/session/parent-1/subagents/call-child/child-1/stream",
          name: "researcher",
          sequence: 0,
          sessionId: "parent-1",
          toolName: "researcher",
          turnId: "turn-1",
          workflowId: "workflow-1",
        },
        type: "subagent.called",
      },
      {
        data: {
          result: {
            callId: "call-child",
            isError: false,
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
          turnId: "turn-1",
        },
        type: "action.result",
      },
      {
        data: {
          callId: "call-child",
          childSessionId: "late-child",
          childStreamPath: "/eve/v1/session/parent-1/subagents/call-child/late-child/stream",
          name: "researcher",
          sequence: 0,
          sessionId: "parent-1",
          toolName: "researcher",
          turnId: "turn-1",
          workflowId: "workflow-1",
        },
        type: "subagent.called",
      },
    );

    expect(graph?.turn?.steps[0]?.actions[0]).toEqual({
      callId: "call-child",
      child: { sessionId: "child-1" },
      kind: "subagent-call",
      name: "researcher",
      phase: "completed",
    });
  });

  it("represents authorization as a settled blocker", () => {
    const graph = reduce(
      { data: { sequence: 0, turnId: "turn-1" }, type: "turn.started" },
      {
        data: {
          description: "Sign in to Notion.",
          name: "notion",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "authorization.required",
      },
      {
        data: {
          name: "notion",
          outcome: "authorized",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-1",
        },
        type: "authorization.completed",
      },
    );

    expect(graph?.turn).toMatchObject({
      blockers: [{ id: "authorization:notion", kind: "authorization", phase: "completed" }],
      phase: "running",
    });
  });
});
