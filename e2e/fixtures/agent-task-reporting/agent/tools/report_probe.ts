import { defineTool, type TaskExec } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Start one requested background reporting probe.",
  execution: "background",
  inputSchema: z.strictObject({
    delayMs: z.number().int().min(1).max(180_000),
    result: z.string().min(1),
  }),
  outputSchema: z.strictObject({
    status: z.literal("working"),
    taskId: z.string(),
  }),
  async execute(input, _ctx, task) {
    void completeProbe(input, task.send);
    return task.delegated({
      executor: { data: input, kind: "report-probe" },
      receipt: {},
    });
  },
});

async function completeProbe(
  input: { readonly delayMs: number; readonly result: string },
  send: TaskExec["send"],
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  await send({ kind: "complete", data: { result: input.result } });
}
