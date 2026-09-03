import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { backgroundToolExecutionProvider } from "#execution/tasks/parent/tool-execution.js";
import { beginBackgroundTask } from "#execution/tasks/parent/delegate.js";
import { sendTaskCommand, sendTaskInboundPayload } from "#execution/tasks/parent/run-parent.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import {
  createBackgroundToolCallBatch,
  type BackgroundExecutableTool,
} from "#harness/background-tools.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("#execution/tasks/parent/delegate.js", () => ({ beginBackgroundTask: vi.fn() }));
vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  sendTaskCommand: vi.fn(),
  sendTaskInboundPayload: vi.fn(),
}));

describe("ordinary background tool execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommand).mockResolvedValue("delivered");
    vi.mocked(sendTaskInboundPayload).mockResolvedValue("delivered");
    vi.mocked(beginBackgroundTask).mockResolvedValue({
      createdByTurnId: "turn-1",
      metadata: { kind: "tool", name: "export" },
      taskId: "task-1",
      taskInboxToken: "inbox-1",
      taskRunId: "run-1",
    });
  });

  it("returns the fixed receipt while routing yields and the final return separately", async () => {
    const ctx = new ContextContainer();
    const session: HarnessSession = setHarnessEmissionState(
      {
        agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "session-1",
      },
      { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
    );
    const provider = await backgroundToolExecutionProvider.create(ctx, session);
    if (provider === undefined) throw new Error("Background executor was not created.");
    const executor = provider.value;
    const definition: BackgroundExecutableTool = {
      name: "export",
      async *execute(_input, _options, task) {
        yield task.setState({ phase: "exporting" });
        yield "progress";
        yield task.postMessage("Review the export");
        return { result: "done" };
      },
    };
    const batch = createBackgroundToolCallBatch();
    batch.setTool("export", definition);
    batch.register({ callId: "call-1", input: {}, toolName: "export" });
    const result = await contextStorage.run(ctx, () =>
      executor.execute({
        batch,
        definition,
        options: { toolCallId: "call-1", messages: [] },
        toolInput: {},
      }),
    );
    expect(result).toEqual({ status: "working", taskId: "task-1" });
    expect(sendTaskCommand).toHaveBeenCalledWith({
      command: { kind: "set-state", state: { phase: "exporting" } },
      taskInboxToken: "inbox-1",
    });
    expect(sendTaskCommand).toHaveBeenCalledWith({
      command: { kind: "complete", data: { result: "done" } },
      taskInboxToken: "inbox-1",
    });
    expect(sendTaskInboundPayload).toHaveBeenCalledWith({
      payload: expect.objectContaining({ kind: "task-update", message: "progress" }),
      taskInboxToken: "inbox-1",
    });
    expect(sendTaskInboundPayload).toHaveBeenCalledWith({
      payload: expect.objectContaining({ kind: "task-message", message: "Review the export" }),
      taskInboxToken: "inbox-1",
    });
  });
});
