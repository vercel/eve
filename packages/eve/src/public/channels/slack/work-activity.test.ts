import { describe, expect, it, vi } from "vitest";

import {
  renderSlackWorkActivity,
  settleSlackWorkActivity,
} from "#public/channels/slack/work-activity.js";

describe("renderSlackWorkActivity", () => {
  it("removes the transient activity message when the parent turn settles", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const channel = {
      slack: { channelId: "C1", request },
      state: { workActivityMessageTs: "activity-1", workActivityTurnId: "turn-1" },
      thread: { post: vi.fn() },
    };

    await settleSlackWorkActivity(channel);

    expect(request).toHaveBeenCalledWith("chat.delete", { channel: "C1", ts: "activity-1" });
    expect(channel.state.workActivityMessageTs).toBeNull();
    expect(channel.state.workActivityTurnId).toBeNull();
  });

  it("posts once then updates the same turn activity message", async () => {
    const post = vi.fn(async () => ({ id: "activity-1" }));
    const request = vi.fn(async () => ({ ok: true }));
    const channel = {
      slack: { channelId: "C1", request },
      state: {},
      thread: { post },
    };
    const running = {
      revision: 1,
      turn: {
        blockers: [],
        id: "turn-1",
        phase: "running" as const,
        steps: [
          {
            actions: [
              {
                callId: "call-1",
                kind: "tool-call" as const,
                name: "search_docs",
                phase: "running" as const,
              },
            ],
            phase: "running" as const,
            stepIndex: 0,
          },
        ],
      },
    };

    await renderSlackWorkActivity({ channel, work: running });
    await renderSlackWorkActivity({
      channel,
      work: {
        ...running,
        revision: 2,
        turn: {
          ...running.turn,
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "completed" },
              ],
              phase: "completed",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("chat.update", {
      blocks: [
        {
          status: "complete",
          task_id: "work-0",
          title: "search_docs",
          type: "task_card",
        },
      ],
      channel: "C1",
      text: "Working\n✓ search_docs",
      ts: "activity-1",
    });
  });

  it("shows the most recent child action while the child turn is still running", async () => {
    const post = vi.fn(async () => ({ id: "activity-1" }));
    const channel = {
      slack: { channelId: "C1", request: vi.fn(async () => ({ ok: true })) },
      state: {},
      thread: { post },
    };

    await renderSlackWorkActivity({
      channel,
      work: {
        revision: 1,
        turn: {
          blockers: [],
          id: "turn-1",
          phase: "running",
          steps: [
            {
              actions: [
                {
                  callId: "child-1",
                  child: {
                    sessionId: "child-session",
                    work: {
                      revision: 5,
                      turn: {
                        blockers: [],
                        id: "turn-0",
                        phase: "running",
                        steps: [
                          {
                            actions: [
                              {
                                callId: "stage-1",
                                kind: "tool-call",
                                detail: "discover",
                                name: "research_stage",
                                phase: "completed",
                              },
                            ],
                            phase: "completed",
                            stepIndex: 0,
                          },
                        ],
                      },
                    },
                  },
                  kind: "subagent-call",
                  name: "researcher",
                  phase: "running",
                },
              ],
              phase: "running",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).toHaveBeenCalledWith({
      blocks: [
        {
          details: {
            elements: [
              {
                elements: [
                  { style: { bold: true }, text: "✓", type: "text" },
                  { text: " discover", type: "text" },
                ],
                type: "rich_text_section",
              },
            ],
            type: "rich_text",
          },
          status: "in_progress",
          task_id: "work-0",
          title: "researcher",
          type: "task_card",
        },
      ],
      text: "Working\n◐ researcher\n  ✓ discover",
    });
  });

  it("does not post when a monitor cannot find the parent-owned activity message", async () => {
    const post = vi.fn(async () => ({ id: "activity-2" }));
    const request = vi.fn(async () => ({ error: "message_not_found", ok: false }));
    const channel = {
      slack: { channelId: "C1", request },
      state: { workActivityMessageTs: "missing", workActivityTurnId: "turn-1" },
      thread: { post },
    };

    await renderSlackWorkActivity({
      allowPost: false,
      channel,
      work: {
        revision: 1,
        turn: {
          blockers: [],
          id: "turn-1",
          phase: "running",
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "running" },
              ],
              phase: "running",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).not.toHaveBeenCalled();
  });

  it("reposts when its tracked message is gone", async () => {
    const post = vi.fn(async () => ({ id: "activity-2" }));
    const request = vi.fn(async () => ({ error: "message_not_found", ok: false }));
    const channel = {
      slack: { channelId: "C1", request },
      state: { workActivityMessageTs: "missing", workActivityTurnId: "turn-1" },
      thread: { post },
    };

    await renderSlackWorkActivity({
      channel,
      work: {
        revision: 1,
        turn: {
          blockers: [],
          id: "turn-1",
          phase: "running",
          steps: [
            {
              actions: [
                { callId: "call-1", kind: "tool-call", name: "search_docs", phase: "running" },
              ],
              phase: "running",
              stepIndex: 0,
            },
          ],
        },
      },
    });

    expect(post).toHaveBeenCalledOnce();
    expect(channel.state.workActivityMessageTs).toBe("activity-2");
  });
});
