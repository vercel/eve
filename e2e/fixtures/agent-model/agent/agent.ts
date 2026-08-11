import { e2eAgentConfig, e2eModel } from "@eve-e2e/config";
import { defineAgent, defineDynamic, type AgentDefinition, type DynamicResolveContext } from "eve";

const model = e2eModel();
const selectedModel =
  process.env.EVE_E2E_MODEL === "mock" ? "eve-mock/dynamic-model" : (model as string);
const { experimental } = e2eAgentConfig();

/**
 * Dynamic-model e2e fixture. Resolves at `turn.started` so one session can
 * exercise repeated selection, missing-selection failure, and resolver
 * failure.
 */
const agent: AgentDefinition = defineAgent({
  experimental,
  model: defineDynamic({
    events: {
      "turn.started": (_event, ctx) => {
        const text = lastUserText(ctx.messages);

        if (text.includes("[model: boom]")) {
          throw new Error("intentional resolver failure");
        }

        if (text.includes("[model: mini]")) {
          return {
            model: selectedModel,
            modelContextWindowTokens: 128_000,
          };
        }

        if (text.includes("[model: catalog]")) {
          return selectedModel;
        }

        if (text.includes("[model: missing]")) {
          return null as never;
        }

        return { model: selectedModel, modelContextWindowTokens: 1_000_000 };
      },
    },
  }),
});

export default agent;

function lastUserText(messages: DynamicResolveContext["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  }
  return "";
}
