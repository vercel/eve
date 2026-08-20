import { defineTool } from "eve/tools";
import { z } from "zod";

const PROGRESS = "EXPORT-PROGRESS";
const RESULT = "EXPORT-COMPLETE";

/**
 * Authored background tool with an in-process executor.
 *
 * Delegates immediately, then posts one task.update and a terminal
 * session.completed over the task binding URL so the parent sees both
 * the intermediate update and the final result.
 */
export default defineTool({
  description: "Start a durable background export.",
  execution: "background",
  inputSchema: z.strictObject({
    query: z.string(),
  }),
  outputSchema: z.strictObject({
    status: z.literal("working"),
    taskId: z.string(),
  }),
  async execute(input, _ctx, task) {
    const callId = `export-${task.binding.taskId}`;
    const executor = {
      data: { query: input.query },
      kind: "export",
    };

    // Hand the binding to a deterministic in-process executor before the
    // tool returns so completion is independent of the parent turn.
    void runExportExecutor({
      binding: task.binding,
      callId,
      query: input.query,
      toolName: "export",
    });

    return task.delegated({
      executor,
      receipt: {},
    });
  },
});

async function runExportExecutor(input: {
  readonly binding: {
    readonly taskId: string;
    readonly token: string;
    readonly url?: string;
  };
  readonly callId: string;
  readonly query: string;
  readonly toolName: string;
}): Promise<void> {
  const url = input.binding.url;
  if (url === undefined) {
    throw new Error("Background export executor requires a task binding URL.");
  }

  // Give the parent turn a moment to acknowledge the delegated task so
  // the update is not buffered past completion.
  await delay(250);

  const updateResponse = await fetch(url, {
    body: JSON.stringify({
      callId: input.callId,
      kind: "task.update",
      message: PROGRESS,
      taskId: input.binding.taskId,
      // Generic executors have no child turn; use a stable epoch and a
      // monotonic updateIndex for parent delivery dedupe.
      updateEpoch: "export-executor",
      updateIndex: 0,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!updateResponse.ok) {
    throw new Error(`Task update failed with HTTP ${updateResponse.status}.`);
  }

  await delay(250);

  const completeResponse = await fetch(url, {
    body: JSON.stringify({
      callId: input.callId,
      kind: "session.completed",
      output: { query: input.query, result: RESULT },
      subagentName: input.toolName,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!completeResponse.ok) {
    throw new Error(`Task completion failed with HTTP ${completeResponse.status}.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
