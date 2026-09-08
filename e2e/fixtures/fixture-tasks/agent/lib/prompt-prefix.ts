import { createHash } from "node:crypto";
import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { z } from "zod";

export const PREFIX_REQUEST =
  "Launch five background workers in parallel and collect their results.";
export const WORKER_COUNT = 5;
export const promptCheckpointSchema = z.object({
  prefix: z.array(z.string()),
  acceptedWorkers: z.number().int().nonnegative(),
  completedWorkers: z.number().int().nonnegative(),
});

export function respondPromptPrefix(request: MockModelRequest): MockModelResponse | string {
  const checkpoints = request.toolResults
    .filter((result) => result.name === "capture_prompt")
    .map((result) => promptCheckpointSchema.parse(result.output));
  const currentPrefix = request.messages.map(fingerprint);

  for (const checkpoint of checkpoints) {
    const changedAt = checkpoint.prefix.findIndex(
      (messageHash, index) => messageHash !== currentPrefix[index],
    );
    if (changedAt !== -1) return `task-prompt-prefix-changed at message ${changedAt}`;
  }

  const acceptedWorkers = request.toolResults.filter(
    (result) => result.name === "busy-worker",
  ).length;
  const completedWorkerIds = new Set(
    request.userMessages
      .filter(
        (message) => message.startsWith("Background task ") && message.includes(" is completed."),
      )
      .flatMap((message) =>
        [...message.matchAll(/PROMPT-CACHE-WORKER-([1-5])/gu)].map((match) => match[1]),
      ),
  );
  const checkpoint = checkpoints.at(-1);
  if (
    checkpoint?.acceptedWorkers !== acceptedWorkers ||
    checkpoint.completedWorkers !== completedWorkerIds.size
  ) {
    return {
      toolCalls: [
        {
          name: "capture_prompt",
          input: {
            prefix: currentPrefix,
            acceptedWorkers,
            completedWorkers: completedWorkerIds.size,
          },
        },
        ...(checkpoints.length === 0
          ? Array.from({ length: WORKER_COUNT }, (_, index) => ({
              id: `prompt-prefix-worker-${index + 1}`,
              name: "busy-worker",
              input: { message: `BUSY-WORKER-A PROMPT-CACHE-WORKER-${index + 1}` },
            }))
          : []),
      ],
    };
  }

  return completedWorkerIds.size === WORKER_COUNT
    ? "task-prompt-prefix-complete"
    : "task-prompt-prefix-waiting";
}

// Hash each message so successive captures do not recursively copy earlier prompts.
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
