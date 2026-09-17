import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Bob performs metered work before an explicitly gated, terminal model rejection.",
  model: mockModel((request) => {
    if (request.toolResults.some((result) => result.name === "release")) {
      // A permanent provider rejection takes the real delegated-session terminal path.
      throw Object.assign(new Error("LIFECYCLE-TERMINAL-REJECTION"), { statusCode: 400 });
    }
    const message = request.userMessages.find((entry) => entry.includes('"parentSessionId"'));
    if (message === undefined) throw new Error("Missing lifecycle worker coordinates.");
    const input = JSON.parse(message.slice(message.indexOf("{")));
    return {
      toolCalls: [{ id: "metered-release", name: "release", input }],
      usage: { inputTokens: 211, outputTokens: 37 },
    };
  }),
  modelContextWindowTokens: 1_000_000,
});
