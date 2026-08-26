import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage, messages, toolResults, tools }) => {
      if (lastUserMessage?.includes("Report the current profile memory")) {
        const visible = messages.map((message) => message.text).join("\n");
        return visible.includes("PROFILE_VALUE=NEW_PROFILE_VALUE") &&
          !visible.includes("PROFILE_VALUE=OLD_PROFILE_VALUE")
          ? "MEMORY_RECALL:NEW_PROFILE_VALUE"
          : "MEMORY_RECALL:STALE_OR_MISSING";
      }
      if (toolResults.some((result) => result.name === "profile__save")) {
        return "MEMORY_TOOL_UPDATED";
      }
      if (
        lastUserMessage?.includes("Update the profile memory") &&
        tools.some((tool) => tool.name === "profile__save")
      ) {
        return {
          toolCalls: [
            {
              id: "memory-save-call",
              input: { value: "NEW_PROFILE_VALUE" },
              name: "profile__save",
            },
          ],
        };
      }
      return "MEMORY_FIXTURE_UNEXPECTED_REQUEST";
    },
  }),
});
