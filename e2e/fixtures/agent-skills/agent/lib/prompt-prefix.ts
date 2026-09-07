import { mockModel } from "eve/evals";
import { z } from "zod";

export const PREFIX_REQUEST = "Verify the durable prompt prefix.";
export const prefixSchema = z.array(
  z.object({ role: z.enum(["assistant", "system", "tool", "user"]), text: z.string() }),
);

export const prefixModel = mockModel({
  modelId: "prompt-prefix-check",
  respond(request) {
    const result = request.toolResults.find((entry) => entry.name === "capture_prompt");
    if (result === undefined) {
      return { toolCalls: [{ name: "capture_prompt", input: { prefix: request.messages } }] };
    }
    const prefix = prefixSchema.parse(result.output);
    const hasAnnouncement = prefix.some(
      (message) => message.role === "user" && message.text.startsWith("Available skills"),
    );
    const stable =
      JSON.stringify(request.messages.slice(0, prefix.length)) === JSON.stringify(prefix);
    return hasAnnouncement && stable ? "prompt-prefix-ok" : "prompt-prefix-changed";
  },
});
