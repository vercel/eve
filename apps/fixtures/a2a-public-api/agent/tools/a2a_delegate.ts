import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import { readRemote, sendRemote } from "../lib/remote-steps";

export default defineWorkflowTool({
  description:
    "Delegate to an A2A agent and monitor durably in the background. Supply taskId instead of message to watch an existing remote task. Canceling this local watcher does not cancel remote work; use a2a__cancel.",
  inputSchema: z
    .object({ message: z.string().optional(), taskId: z.string().optional() })
    .refine(
      (input) => Boolean(input.message) !== Boolean(input.taskId),
      "Supply message or taskId, not both",
    ),
  execution: "background",
  async *execute(input, ctx, task) {
    "use workflow";
    let remote = input.taskId ? await readRemote(input.taskId) : await sendRemote(input.message!);
    yield task.postMessage(`A2A remote task ${remote.id} started. Local watcher ${task.taskId}.`);
    let lastQuestion = "";
    while (
      ![
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
      ].includes(remote.status.state)
    ) {
      if (ctx.abortSignal.aborted) return { remoteTaskId: remote.id, monitoringStopped: true };
      if (
        remote.status.state === "TASK_STATE_INPUT_REQUIRED" ||
        remote.status.state === "TASK_STATE_AUTH_REQUIRED"
      ) {
        const question = JSON.stringify(remote.status);
        if (question !== lastQuestion) {
          yield task.postMessage(
            `A2A task ${remote.id} needs input: ${JSON.stringify(remote.status.message)}. Use a2a__send with this remote taskId to reply.`,
          );
          lastQuestion = question;
        }
      }
      yield { remoteTaskId: remote.id, state: remote.status.state };
      await sleep("1s");
      remote = await readRemote(remote.id);
    }
    if (
      remote.status.state === "TASK_STATE_FAILED" ||
      remote.status.state === "TASK_STATE_REJECTED"
    )
      throw new Error(`A2A task failed: ${JSON.stringify(remote.status.message)}`);
    return remote;
  },
});
