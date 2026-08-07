import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Return one deterministic marker for each message.",
  model: mockModel((request) => {
    const message = request.lastUserMessage ?? "";
    if (message.includes("BUSY-WORKER-A") || message.includes("BUSY-WORKER-B")) {
      if (!request.toolResults.some((result) => result.id === "exclusivity-hold")) {
        return {
          toolCalls: [{ id: "exclusivity-hold", input: { marker: "HOLD" }, name: "hold" }],
        };
      }
    }
    return `BUSY-WORKER:${message}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
