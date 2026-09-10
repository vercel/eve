import { afterEach, describe, expect, it, vi } from "vitest";

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
