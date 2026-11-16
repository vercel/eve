import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { createDefaultEvents } from "#public/channels/linear/defaults.js";

const activities = vi.hoisted(() => [] as { content: unknown }[]);
vi.mock("#public/channels/linear/api.js", () => ({
  createLinearAgentActivity: vi.fn(async (input: { activity: { content: unknown } }) => {
    activities.push(input.activity);
    return { id: `activity_${activities.length}`, success: true };
  }),
}));

describe("Linear activity for calls", () => {
  it("posts the model's call and nothing for the calls a program makes inside it", async () => {
    const events = createDefaultEvents();
    const ctx = { channel: { state: { agentSessionId: "as_1" } }, session: { auth: {} } };
    const run = async (fact: unknown) => {
      const { type } = fact as SessionEvent;
      const handler = events[type as keyof typeof events] as
        | ((event: unknown, ctx: unknown) => Promise<void>)
        | undefined;
      await handler?.(fact, ctx);
    };

    await run({
      data: {
        callId: "call_run",
        capability: { kind: "tool", label: "Run code", name: "eve__execute" },
        input: {},
        owner: { runId: "run_0" },
      },
      type: "call.requested",
    });
    expect(activities.map((activity) => activity.content)).toEqual([
      expect.objectContaining({ action: "Run code", type: "action" }),
    ]);

    await run({
      data: {
        callId: "call_run/1",
        capability: { kind: "tool", name: "read_file" },
        input: {},
        owner: { callId: "call_run" },
      },
      type: "call.requested",
    });
    await run({
      data: { callId: "call_run/1", label: "Reading", output: {} },
      type: "call.progress",
    });
    await run({
      data: { callId: "call_run/1", label: "Read 1 file", outcome: "completed" },
      type: "call.settled",
    });
    expect(activities).toHaveLength(1);
  });
});
