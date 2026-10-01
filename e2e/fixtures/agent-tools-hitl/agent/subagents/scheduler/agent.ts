import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const SCHEDULER_DIRECTIVE = /SCHEDULER (read|delete)/u;

/**
 * Scripted on every model so the tool-stubs evals stay deterministic: it calls
 * the schedule tool its SCHEDULER directive names once and replies with the
 * result.
 */
export default defineAgent({
  description:
    "Test fixture: handles SCHEDULER directives about Alice's schedules. Call it only for SCHEDULER directives.",
  model: mockModel({
    modelId: "scheduler",
    respond(request) {
      const action = SCHEDULER_DIRECTIVE.exec(request.lastUserMessage ?? "")?.[1];
      const tool = action === "delete" ? "schedules_delete" : "schedules_read";
      const roles = request.messages.map((entry) => entry.role);
      if (roles.lastIndexOf("tool") < roles.lastIndexOf("user")) {
        return {
          toolCalls: [{ name: tool, input: tool === "schedules_delete" ? { id: "sched_1" } : {} }],
        };
      }
      const result = request.toolResults.find((entry) => entry.name === tool);
      return JSON.stringify(result?.output ?? "The schedule tool failed.");
    },
  }),
  modelContextWindowTokens: 1_000_000,
});
