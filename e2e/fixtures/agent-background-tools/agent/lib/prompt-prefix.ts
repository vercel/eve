import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { z } from "zod";

export const PREFIX_REQUEST = "Verify background task prompt history.";
export const prefixSchema = z.array(
  z.object({ role: z.enum(["assistant", "system", "tool", "user"]), text: z.string() }),
);

export function respondPromptPrefix(request: MockModelRequest): MockModelResponse | string {
  const captures = request.toolResults.filter((result) => result.name === "capture_prompt");
  for (const capture of captures) {
    const prefix = prefixSchema.parse(capture.output);
    if (JSON.stringify(request.messages.slice(0, prefix.length)) !== JSON.stringify(prefix)) {
      return "task-prompt-prefix-changed";
    }
  }

  const snapshots = request.messages.filter(
    (message) => message.role === "user" && message.text.startsWith("[Task state]\n"),
  );
  if (snapshots.length !== captures.length) return "task-prompt-history-missing";
  if (captures.length === 2) return "task-prompt-prefix-ok";

  return {
    toolCalls: [
      { name: "capture_prompt", input: { prefix: request.messages } },
      { name: "export", input: { query: `prefix-${captures.length + 1}` } },
    ],
  };
}
