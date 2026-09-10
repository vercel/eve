import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalSessionDriver } from "#evals/session.js";
import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

vi.mock("eve/evals/expect", () => ({
  satisfies: (predicate: (value: unknown) => boolean) => ({ predicate }),
}));

const fixture = new URL("../../../e2e/fixtures/fixture-tasks/evals/shared.ts", import.meta.url);
const { waitForTaskStatus, waitForTaskNotification } = await import(fixture.pathname);

afterEach(() => vi.restoreAllMocks());

function turn(message: string, output?: unknown) {
  const value = {
    events: [{ type: "message.received", data: { message } }],
    toolCalls: output === undefined ? [] : [{ name: "task_cancel", output }],
    noFailedActions: vi.fn(() => ({ label: vi.fn() })),
  };
  return value;
}

describe("task fixture status synchronization", () => {
  it("verifies cancellation after the real client skips an earlier task notification", async () => {
    const output = { tasks: [{ taskId: "task-1", status: "cancelled" }] };
    const record = (sequence: number, deliveryId: string, message: string, cancel: boolean) => {
      const data = { sequence, stepIndex: 0, turnId: `turn_${sequence}` };
      const meta = { at: "2026-09-10T00:00:00.000Z", deliveryIds: [deliveryId] };
      return [
        { type: "turn.started", data, meta },
        { type: "message.received", data: { ...data, message }, meta },
        ...(cancel
          ? [
              {
                type: "actions.requested",
                data: {
                  ...data,
                  actions: [
                    {
                      kind: "tool-call",
                      toolName: "task_cancel",
                      callId: deliveryId,
                      input: { taskIds: ["task-1"] },
                    },
                  ],
                },
                meta,
              },
              {
                type: "action.result",
                data: {
                  ...data,
                  status: "completed",
                  result: {
                    kind: "tool-result",
                    toolName: "task_cancel",
                    callId: deliveryId,
                    output,
                  },
                },
                meta,
              },
            ]
          : []),
        {
          type: "message.completed",
          data: { ...data, message: "Cancelled.", finishReason: "stop" },
          meta,
        },
        { type: "turn.completed", data, meta },
        { type: "session.waiting", meta },
      ];
    };
    const stream = (events: unknown[]) =>
      new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
        headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
      });
    const notification = record(
      3,
      "task-notification",
      "Background task task-1 (worker) is cancelled.",
      false,
    );
    const repeated = record(4, "repeat-cancel", "CANCEL AGAIN", true);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session-1", deliveryId: "repeat-cancel" }, { status: 202 }),
      )
      .mockResolvedValueOnce(stream([...notification, ...repeated]))
      .mockResolvedValueOnce(
        Response.json({ sessionId: "session-1", deliveryId: "verify" }, { status: 202 }),
      )
      .mockResolvedValueOnce(stream(record(5, "verify", "VERIFY task-1", true)));
    const client = new Client({ host: "https://eve.test" });
    const session = new EvalSessionDriver({
      client,
      collector: new AssertionCollector(),
      primary: false,
      session: client.sessions.attach("session-1"),
    });
    await session.send("CANCEL AGAIN");
    expect(session.events).toEqual(repeated);
    expect(session.state?.streamIndex).toBe(notification.length + repeated.length);
    const t = {
      target: {
        watchTurn: vi.fn(() => {
          throw new Error("The notification is behind the correlated stream cursor.");
        }),
      },
      require: vi.fn(async (value: unknown, check: { predicate: (value: unknown) => boolean }) => {
        expect(check.predicate(value)).toBe(true);
      }),
    };
    const verified = await waitForTaskStatus(t, session, "VERIFY", "task-1", "cancelled");
    expect(verified.requireToolCall("task_cancel").output).toEqual(output);
    expect(t.target.watchTurn).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("waits for terminal notification before sending one verification turn", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof turn>>();
    const session = {
      sessionId: "session-1",
      state: { streamIndex: 10 },
      events: [],
      send: vi.fn(async () => {
        await pending.promise;
        return turn("VERIFY task-1", { tasks: [{ taskId: "task-1", status: "failed" }] });
      }),
    };
    const t = {
      target: { watchTurn: vi.fn(() => ({ session, result: () => pending.promise })) },
      require: vi.fn(async (value: unknown, check: { predicate: (value: unknown) => boolean }) => {
        expect(check.predicate(value)).toBe(true);
      }),
      sleep: vi.fn(),
    };
    const result = waitForTaskStatus(t, session, "VERIFY", "task-1", "failed");
    try {
      await Promise.resolve();
      expect(session.send).not.toHaveBeenCalled();
    } finally {
      pending.resolve(turn("Background task task-1 (worker) failed.\n\nError: test failure."));
      await result;
    }
    expect(session.send).toHaveBeenCalledExactlyOnceWith("VERIFY task-1");
    expect(t.target.watchTurn).toHaveBeenCalledExactlyOnceWith("session-1", { startIndex: 10 });
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it("recognizes the runtime's failed-notification wording", async () => {
    const session = { sessionId: "session-1", state: { streamIndex: 0 }, events: [] };
    const notification = turn("Background task task-1 (worker) failed.\n\nError: test failure.");
    const t = {
      target: {
        watchTurn: vi
          .fn()
          .mockReturnValueOnce({ session, result: async () => notification })
          .mockImplementation(() => {
            throw new Error("Unexpected extra wait");
          }),
      },
    };
    await expect(waitForTaskNotification(t, session, "task-1", "failed")).resolves.toEqual({
      session,
      turn: notification,
    });
  });

  it("matches the task and headline status, not a status mentioned in the result", async () => {
    const session = { sessionId: "session-1", state: { streamIndex: 0 }, events: [] };
    const expected = turn("Background task task-1 (worker) failed.");
    const t = {
      target: {
        watchTurn: vi
          .fn()
          .mockReturnValueOnce({
            session,
            result: async () => turn("Background task task-2 (worker) failed."),
          })
          .mockReturnValueOnce({
            session,
            result: async () =>
              turn("Background task task-1 (worker) is completed.\n\nAn earlier check failed."),
          })
          .mockReturnValueOnce({ session, result: async () => expected }),
      },
    };
    await expect(waitForTaskNotification(t, session, "task-1", "failed")).resolves.toEqual({
      session,
      turn: expected,
    });
    expect(t.target.watchTurn).toHaveBeenCalledTimes(3);
  });

  it("reuses a terminal notification already observed without waiting for another", async () => {
    const session = {
      sessionId: "session-1",
      state: { streamIndex: 10 },
      events: turn("Background task task-1 (worker) is completed.").events,
      send: vi.fn(async () =>
        turn("VERIFY task-1", { tasks: [{ taskId: "task-1", status: "completed" }] }),
      ),
    };
    const t = {
      target: {
        watchTurn: vi.fn(() => {
          throw new Error("Unexpected extra wait");
        }),
      },
      require: vi.fn(async (value: unknown, check: { predicate: (value: unknown) => boolean }) => {
        expect(check.predicate(value)).toBe(true);
      }),
    };
    await waitForTaskStatus(t, session, "VERIFY", "task-1", "completed");
    expect(session.send).toHaveBeenCalledExactlyOnceWith("VERIFY task-1");
    expect(t.target.watchTurn).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "completed", "failed"])(
    "verifies an already observed %s task without waiting for another notification",
    async (status) => {
      const output = { tasks: [{ taskId: "task-1", status }] };
      const session = {
        sessionId: "session-1",
        state: { streamIndex: 50 },
        events: [
          {
            type: "action.result",
            data: {
              status: "completed",
              result: { kind: "tool-result", toolName: "task_cancel", output },
            },
          },
        ],
        send: vi.fn(async () => turn("VERIFY task-1", output)),
      };
      const t = {
        target: {
          watchTurn: vi.fn(() => {
            throw new Error("The correlated send has already advanced past the notification.");
          }),
        },
        require: vi.fn(
          async (value: unknown, check: { predicate: (value: unknown) => boolean }) => {
            expect(check.predicate(value)).toBe(true);
          },
        ),
      };
      await waitForTaskStatus(t, session, "VERIFY", "task-1", status);
      expect(session.send).toHaveBeenCalledExactlyOnceWith("VERIFY task-1");
      expect(t.target.watchTurn).not.toHaveBeenCalled();
      expect(t.require).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "another task", taskId: "task-2", status: "cancelled", actionStatus: "completed" },
    { name: "a working task", taskId: "task-1", status: "working", actionStatus: "completed" },
    { name: "a failed action", taskId: "task-1", status: "cancelled", actionStatus: "failed" },
  ])("does not treat $name as terminal evidence", async ({ taskId, status, actionStatus }) => {
    const output = { tasks: [{ taskId: "task-1", status: "cancelled" }] };
    const session = {
      sessionId: "session-1",
      state: { streamIndex: 50 },
      events: [
        {
          type: "action.result",
          data: {
            status: actionStatus,
            result: {
              kind: "tool-result",
              toolName: "task_cancel",
              output: { tasks: [{ taskId, status }] },
            },
          },
        },
      ],
      send: vi.fn(async () => turn("VERIFY task-1", output)),
    };
    const t = {
      target: {
        watchTurn: vi.fn(() => ({
          session,
          result: async () => turn("Background task task-1 (worker) is cancelled."),
        })),
      },
      require: vi.fn(async (value: unknown, check: { predicate: (value: unknown) => boolean }) => {
        expect(check.predicate(value)).toBe(true);
      }),
    };
    await waitForTaskStatus(t, session, "VERIFY", "task-1", "cancelled");
    expect(t.target.watchTurn).toHaveBeenCalledExactlyOnceWith("session-1", { startIndex: 50 });
    expect(session.send).toHaveBeenCalledExactlyOnceWith("VERIFY task-1");
  });

  it("does not inspect a task after the existing 30-second deadline", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    const session = {
      sessionId: "session-1",
      state: { streamIndex: 0 },
      events: [],
      send: vi.fn(),
    };
    const t = {
      target: {
        watchTurn: vi.fn(() => ({
          session,
          result: async () => turn("Background task task-1 (worker) is completed."),
        })),
      },
    };
    await expect(waitForTaskStatus(t, session, "VERIFY", "task-1", "completed")).rejects.toThrow(
      /30 seconds/,
    );
    expect(session.send).not.toHaveBeenCalled();
  });
});
