import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { FILE_MEMORY_FACT, FILE_MEMORY_PHRASE } from "./constants.js";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage, messages, toolResults, tools }) => {
      if (lastUserMessage?.startsWith("What is the verification phrase")) {
        const recalls = messages.filter((message) => message.text.includes(FILE_MEMORY_FACT));
        return recalls.length === 1
          ? FILE_MEMORY_PHRASE
          : recalls.length === 0
            ? "FILE_MEMORY_NOT_FOUND"
            : "FILE_MEMORY_DUPLICATED";
      }
      if (toolResults.some((result) => result.name === "file__save_memory")) {
        return "FILE_MEMORY_SAVED";
      }
      if (
        lastUserMessage?.includes("file__save_memory") &&
        lastUserMessage.includes(FILE_MEMORY_FACT) &&
        tools.some((tool) => tool.name === "file__save_memory")
      ) {
        return {
          toolCalls: [
            {
              id: "file-memory-save-call",
              input: { text: FILE_MEMORY_FACT },
              name: "file__save_memory",
            },
          ],
        };
      }
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
