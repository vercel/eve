import { afterEach, describe, expect, it, vi } from "vitest";

import { fireTaskUpdateCallbackStep } from "#execution/session-callback-step.js";
import { executeTaskUpdate } from "#execution/tasks/child/update.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));
vi.mock("#execution/session-callback-step.js", () => ({
  fireTaskUpdateCallbackStep: vi.fn(),
}));

const action = {
  callId: "update-call",
  input: { message: "Found three matching records." },
  kind: "tool-call" as const,
  toolName: "task_update",
};

afterEach(() => vi.resetAllMocks());

describe("executeTaskUpdate", () => {
  it("sends local updates through the owning task inbox", async () => {
    const token = "task:task_abc:0123456789abcdef0123456789abcdef";
    const result = await executeTaskUpdate({
      action,
      adapter: {
        kind: "subagent",
        state: {
          callId: "parent-call",
          parentContinuationToken: token,
          parentSessionId: "parent-session",
          subagentName: "agent",
        },
      } as never,
      updateIndex: 2,
      updateEpoch: "turn-child",
      serializedContext: {},
    });

    expect(resumeHookMock).toHaveBeenCalledWith(token, {
      callId: "update-call",
      updateIndex: 2,
      updateEpoch: "turn-child",
      kind: "task-update",
      message: "Found three matching records.",
    });
    expect(result).toMatchObject({
      output: { message: "Found three matching records.", status: "sent", taskId: "task_abc" },
    });
  });

  it("sends remote updates through the owning task callback", async () => {
    vi.mocked(fireTaskUpdateCallbackStep).mockResolvedValue("task_abc");
    const callback = {
      callId: "parent-call",
      subagentName: "agent",
      taskId: "task_abc",
      token: "task-token",
      url: "https://parent.example/eve/v1/callback/task-token",
    };
    const result = await executeTaskUpdate({
      action,
      adapter: undefined,
      updateIndex: 2,
      updateEpoch: "turn-child",
      serializedContext: { "eve.sessionCallback": callback },
    });

    expect(fireTaskUpdateCallbackStep).toHaveBeenCalledWith({
      callback,
      callId: "update-call",
      updateIndex: 2,
      updateEpoch: "turn-child",
      message: "Found three matching records.",
    });
    expect(result).toMatchObject({
      output: { message: "Found three matching records.", status: "sent", taskId: "task_abc" },
    });
  });
});
