import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Verifies custom sandbox provider session capabilities.",
  ...e2eSubagentConfig(),
  model: mockModel({
    modelId: "custom-provider-session",
    respond(request) {
      const result = request.toolResults.find((entry) => entry.name === "verify-provider-session");
      return result === undefined
        ? { toolCalls: [{ input: {}, name: "verify-provider-session" }] }
        : String(result.output);
    },
  }),
});
