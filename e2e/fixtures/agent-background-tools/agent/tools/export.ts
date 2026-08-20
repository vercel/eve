import { defineTool, type TaskExec } from "eve/tools";
import { z } from "zod";

const PROGRESS = "EXPORT-PROGRESS";
const RESULT = "EXPORT-COMPLETE";

/**
 * Authored background tool with an in-process executor.
 *
 * Delegates immediately, then reports one progress update and a terminal
 * result through the task capability so the parent sees both.
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
    const executor = {
      data: { query: input.query },
      kind: "export",
    };

    // Start a deterministic in-process executor before the tool returns so
    // completion is independent of the parent turn.
    void runExportExecutor({
      query: input.query,
      send: task.send,
    });

    return task.delegated({
      executor,
      receipt: {},
    });
  },
});

async function runExportExecutor(input: {
  readonly query: string;
  readonly send: TaskExec["send"];
}): Promise<void> {
  // Give the parent turn a moment to acknowledge the delegated task so
  // the update is not buffered past completion.
  await delay(250);

  await input.send({
    kind: "update",
    message: PROGRESS,
  });

  await delay(250);

  await input.send({
    data: { query: input.query, result: RESULT },
    kind: "complete",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
