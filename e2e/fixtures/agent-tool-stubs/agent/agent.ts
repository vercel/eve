import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: (request) => {
      const roles = request.messages.map((message) => message.role);
      const hasResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");
      const result = request.toolResults.at(-1);
      const message = request.lastUserMessage ?? "";
      const lookupInput = () => JSON.parse(message.split("Lookup input: ")[1]!);
      if (hasResult) {
        if (result?.name === "complete_task") {
          return { toolCalls: [{ name: "list_tasks", input: {} }] };
        }
        if (
          result?.name === "lookup_record" &&
          JSON.stringify(result.output) === '{"marker":"pending"}'
        ) {
          return { toolCalls: [{ name: "lookup_record", input: lookupInput() }] };
        }
        return JSON.stringify(result?.output);
      }
      if (message.includes("Lookup input: ")) {
        return {
          toolCalls: [{ name: "lookup_record", input: lookupInput() }],
        };
      }
      if (message.includes("complete Buy milk")) {
        return { toolCalls: [{ name: "complete_task", input: { task_id: "milk" } }] };
      }
      return { toolCalls: [{ name: "list_tasks", input: {} }] };
    },
  }),
});
