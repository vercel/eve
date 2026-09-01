import { describe, expect, it } from "vitest";

import { CHANNEL_CONTEXT_KEY_NAME, SESSION_CALLBACK_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { isTaskOwnedSerializedContext } from "#execution/tasks/child/instructions.js";

describe("isTaskOwnedSerializedContext", () => {
  it("recognizes callback contexts with explicit task ownership", () => {
    expect(
      isTaskOwnedSerializedContext({
        [SESSION_CALLBACK_CONTEXT_KEY_NAME]: { taskId: "task_abc" },
      }),
    ).toBe(true);
  });

  it("recognizes legacy subagent contexts whose parent token is a task inbox", () => {
    expect(
      isTaskOwnedSerializedContext({
        [CHANNEL_CONTEXT_KEY_NAME]: {
          state: {
            parentContinuationToken: "task:task_abc:0123456789abcdef0123456789abcdef",
          },
        },
      }),
    ).toBe(true);
  });

  it("recognizes task-owned subagent contexts with an opaque parent hook", () => {
    expect(
      isTaskOwnedSerializedContext({
        [CHANNEL_CONTEXT_KEY_NAME]: {
          kind: SUBAGENT_ADAPTER_KIND,
          state: {
            callId: "call-1",
            parentContinuationToken: "opaque-invocation-reply-hook",
            parentSessionId: "sess-parent",
            subagentName: "worker",
            taskId: "task_abc",
          },
        },
      }),
    ).toBe(true);
  });

  it("does not treat ordinary subagent contexts as task-owned", () => {
    expect(
      isTaskOwnedSerializedContext({
        [CHANNEL_CONTEXT_KEY_NAME]: {
          kind: SUBAGENT_ADAPTER_KIND,
          state: {
            callId: "call-1",
            parentContinuationToken: "opaque-invocation-reply-hook",
            parentSessionId: "sess-parent",
            subagentName: "worker",
          },
        },
      }),
    ).toBe(false);
  });
});
