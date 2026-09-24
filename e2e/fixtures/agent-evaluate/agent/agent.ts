import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

import { fixtureModel, routing } from "./testing";

const { experimental } = e2eAgentConfig();

export default defineAgent({
  experimental,
  model: fixtureModel(async (request) => {
    if (request.userMessages.some((text) => text.includes("automatic-review"))) {
      const result = request.toolResults.find((entry) => entry.name === "automatic-review");
      if (result) {
        return JSON.stringify({
          isError: result.isError,
          output: result.output,
          routing: routing.get(),
        });
      }
      return {
        toolCalls: [
          {
            id: "automatic-review-1",
            name: "automatic-review",
            input: {
              effect: request.userMessages.some((text) => text.includes("malicious"))
                ? "malicious"
                : "safe",
            },
          },
        ],
      };
    }
    if (request.userMessages.some((text) => text.includes("evaluate-request"))) {
      const result = request.toolResults.find((result) => result.name === "evaluate-request");
      if (result) return JSON.stringify({ isError: result.isError, output: result.output });
      return {
        toolCalls: [
          {
            id: "evaluate-request-1",
            name: "evaluate-request",
            input: {
              missingAnswer: request.userMessages.some((text) => text.includes("missing answer")),
            },
          },
        ],
      };
    }
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
