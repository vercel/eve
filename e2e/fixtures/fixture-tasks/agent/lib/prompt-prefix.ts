import { createHash } from "node:crypto";
import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { z } from "zod";

export const PREFIX_REQUEST =
  "Launch five background workers in parallel and collect their results.";
export const WORKER_COUNT = 5;
export const prefixSchema = z.object({ context: z.string(), prefix: z.array(z.string()) });

export function respondPromptPrefix(request: MockModelRequest): MockModelResponse | string {
  const captures = request.toolResults
    .filter((result) => result.name === "capture_prompt")
    .map((result) => prefixSchema.parse(result.output));
  const prefix = request.messages.map(fingerprint);
  for (const capture of captures) {
    const changed = capture.prefix.findIndex((hash, index) => hash !== prefix[index]);
    if (changed !== -1) return `task-prompt-prefix-changed at message ${changed}`;
  }

  const context = fingerprint(request.messages.filter((message) => message.role === "user"));
  if (captures.at(-1)?.context !== context) {
    return {
      toolCalls: [
        { name: "capture_prompt", input: { context, prefix } },
        ...(captures.length === 0
          ? Array.from({ length: WORKER_COUNT }, (_, index) => ({
              id: `prompt-prefix-worker-${index + 1}`,
              name: "busy-worker",
              input: { message: `BUSY-WORKER-A PROMPT-CACHE-WORKER-${index + 1}` },
            }))
          : []),
      ],
    };
  }

  const completed = new Set(
    request.userMessages
      .filter(
        (message) => message.startsWith("Background task ") && message.includes(" is completed."),
      )
      .flatMap((message) =>
        [...message.matchAll(/PROMPT-CACHE-WORKER-([1-5])/gu)].map((match) => match[1]),
      ),
  );
  return completed.size === WORKER_COUNT
    ? "task-prompt-prefix-complete"
    : "task-prompt-prefix-waiting";
}

// Hash each message so successive captures do not recursively copy earlier prompts.
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
