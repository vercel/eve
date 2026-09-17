import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { fixtureModel, routing } from "./testing";

const { experimental } = e2eAgentConfig();

export default defineAgent({
  experimental,
  model: fixtureModel(async (request) => {
    if (request.userMessages.some((text) => text.includes("parallel investigations"))) {
      const completed = request.messages.filter((message) =>
        message.text.includes("child-result:"),
      );
      if (completed.length > 0) return completed.map((message) => message.text).join("\n");
      if (request.toolResults.some((result) => result.name === "worker")) {
        return "Waiting for investigations.";
      }
      return {
        toolCalls: [
          {
            id: "worker-alice",
            name: "worker",
            input: { message: "Alice owns a difficult investigation." },
          },
          {
            id: "worker-bob",
            name: "worker",
            input: { message: "Bob owns a routine investigation." },
          },
        ],
      };
    }
    return JSON.stringify(routing.get());
  }),
});
