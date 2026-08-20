import { describe, expect, it } from "vitest";

import { describeWorkGraph } from "#public/channels/slack/action-status.js";

describe("describeWorkGraph", () => {
  it("prioritizes a blocker over active actions", () => {
    expect(
      describeWorkGraph({
        revision: 1,
        turn: {
          blockers: [{ id: "auth", kind: "authorization", phase: "blocked" }],
          id: "turn-1",
          phase: "blocked",
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "read_file", phase: "running" },
              ],
              phase: "running",
              stepIndex: 0,
            },
          ],
        },
      }),
    ).toBe("Waiting for sign-in...");
  });

  it("summarizes the newest active step", () => {
    expect(
      describeWorkGraph({
        revision: 1,
        turn: {
          blockers: [],
          id: "turn-1",
          phase: "running",
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "completed" },
              ],
              phase: "completed",
              stepIndex: 0,
            },
            {
              actions: [
                { callId: "call-2", kind: "subagent-call", name: "researcher", phase: "running" },
                { callId: "call-3", kind: "tool-call", name: "read_file", phase: "running" },
              ],
              phase: "running",
              stepIndex: 1,
            },
          ],
        },
      }),
    ).toBe("researcher +1 more");
  });
});
