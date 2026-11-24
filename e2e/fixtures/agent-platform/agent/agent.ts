import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { BOB_FACT } from "./constants.js";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage, messages, toolResults, tools }) => {
      const ledger = toolResults.find((result) => result.name === "platform_ledger");
      if (ledger !== undefined) {
        const { note, writes } = ledger.output as { note: string | null; writes: number };
        return writes > 0 ? `LEDGER ${note} WRITTEN` : `LEDGER ${note} EMPTY`;
      }
      if (toolResults.some((result) => result.name === "notes__save_memory")) {
        return "NOTE_SAVED";
      }
      if (
        lastUserMessage?.includes(BOB_FACT) &&
        tools.some((tool) => tool.name === "notes__save_memory")
      ) {
        return {
          toolCalls: [
            { id: "notes-save-call", input: { text: BOB_FACT }, name: "notes__save_memory" },
          ],
        };
      }
      if (lastUserMessage?.startsWith("Alice asks what her notes say")) {
        const visible = messages.map((message) => message.text).join("\n");
        return visible.includes(BOB_FACT) ? "THURSDAY" : "NOTE_MISSING";
      }
      if (
        lastUserMessage?.startsWith("Bob asks to see the platform ledger") &&
        tools.some((tool) => tool.name === "platform_ledger")
      ) {
        return { toolCalls: [{ id: "ledger-call", input: {}, name: "platform_ledger" }] };
      }
      return "PLATFORM_FIXTURE_UNEXPECTED_REQUEST";
    },
  }),
});
