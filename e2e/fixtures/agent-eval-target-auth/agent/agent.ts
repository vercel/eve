import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: (request) => {
      const result = request.toolResults.at(-1);
      if (request.messages.at(-1)?.role === "tool") return JSON.stringify(result?.output);
      const message = request.lastUserMessage ?? "";
      if (message.startsWith("Save a note")) {
        return { toolCalls: [{ name: "save_note", input: { id: "T-1", note: "Called Alice." } }] };
      }
      return { toolCalls: [{ name: "lookup_ticket", input: { id: "T-1" } }] };
    },
  }),
});
