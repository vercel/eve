import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

import { WORKSPACE_LOOKUP_MESSAGE } from "../constants";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const base = e2eAgentConfig();
const { model, modelContextWindowTokens, ...agentConfig } = base;
const workspaceReader = mockModel({
  modelId: "principal-forwarding-workspace-reader",
  respond: ({ messages }) => {
    for (const message of [...messages].reverse()) {
      if (message.role === "tool") return message.text;
      if (message.role === "user" && message.text === WORKSPACE_LOOKUP_MESSAGE) break;
    }
    return { toolCalls: [{ name: "read-workspace-label", input: {} }] };
  },
});

export default defineAgent({
  ...agentConfig,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        // Authorization must reach the real tool even if a provider declines the lookup.
        const isWorkspaceReader = ctx.messages.some((message) => {
          if (message.role !== "user") return false;
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
          return text === WORKSPACE_LOOKUP_MESSAGE;
        });
        return isWorkspaceReader
          ? { model: workspaceReader, modelContextWindowTokens: 1_000_000 }
          : { model, modelContextWindowTokens };
      },
    },
  }),
  reasoning: "high",
});
