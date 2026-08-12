import { beforeEach, describe, expect, it, vi } from "vitest";

import { settleTaskDispatchError } from "#execution/tasks/parent/continuation-dispatch.js";
import {
  failDelegatedDispatch,
  rejectDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";

vi.mock("#execution/tasks/parent/delegate.js", () => ({
  failDelegatedDispatch: vi.fn(),
  rejectDelegatedDispatch: vi.fn(),
  settleDelegatedDispatch: vi.fn(),
}));

const task = {
  taskInboxToken: "task-token",
  createdByTurnId: "turn-parent",
  metadata: {
    agentId: "agent-1",
    kind: "subagent" as const,
    mode: "remote" as const,
    name: "research",
  },
  operationId: "operation-1",
  taskId: "task_1",
  taskRunId: "run-1",
};

function outcome(deliveryAmbiguous: boolean) {
  return {
    deliveryAmbiguous,
    kind: "error" as const,
    result: {
      callId: "call-1",
      isError: true as const,
      kind: "subagent-result" as const,
      origin: "dispatch" as const,
      output: { code: "AGENT_UNREACHABLE", message: "rejected" },
      subagentName: "research",
    },
    session: {} as never,
  };
}

describe("settleTaskDispatchError", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fails an indexed task after a definitive continuation rejection", async () => {
    const rejected = outcome(false);

    await settleTaskDispatchError({
      delegated: task,
      outcome: rejected,
      persisted: { receipt: {} as never, session: rejected.session },
    });

    expect(failDelegatedDispatch).toHaveBeenCalledWith({
      error: rejected.result.output,
      task,
    });
    expect(rejectDelegatedDispatch).not.toHaveBeenCalled();
  });

  it("leaves an indexed task pending only when delivery was ambiguous", async () => {
    const ambiguous = outcome(true);

    await settleTaskDispatchError({
      delegated: task,
      outcome: ambiguous,
      persisted: { receipt: {} as never, session: ambiguous.session },
    });

    expect(failDelegatedDispatch).not.toHaveBeenCalled();
    expect(rejectDelegatedDispatch).not.toHaveBeenCalled();
  });
});
