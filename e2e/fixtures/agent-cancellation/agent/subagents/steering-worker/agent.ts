import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description:
    "A deterministic worker for background correction evals. Preserves its original memo.",
  model: mockModel((request) => {
    const assignment = request.userMessages.find((message) => message.startsWith("ASSIGNMENT "));
    if (assignment === undefined) throw new Error("Worker has no original assignment.");
    const memo = assignment.slice("ASSIGNMENT ".length).trim();
    const corrected = request.userMessages.some((message) => message.includes("CORRECTED"));
    if (corrected) return `WORKER-RESULT:CORRECTED:${memo}`;

    if (request.toolResults.some((result) => result.name === "wait-for-cancellation")) {
      return `WORKER-RESULT:ORIGINAL:${memo}`;
    }
    return {
      toolCalls: [{ id: "hold-original-work", name: "wait-for-cancellation", input: {} }],
    };
  }),
  modelContextWindowTokens: 1_000_000,
});
