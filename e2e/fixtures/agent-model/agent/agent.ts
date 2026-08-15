import { e2eAgentConfig, e2eModel } from "@eve-e2e/config";
import { defineAgent, defineDynamic, type AgentDefinition, type DynamicResolveContext } from "eve";

const model = e2eModel();
const { experimental } = e2eAgentConfig();

/**
 * Dynamic-model e2e fixture. Resolves at `step.started` so live model objects
 * exercise the same selection, omission, and failure paths as gateway ids.
 */
const agent: AgentDefinition = defineAgent({
  experimental,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const text = lastUserText(ctx.messages);

        if (text.includes("[model: boom]")) {
          throw new Error("intentional resolver failure");
        }

        if (text.includes("[model: mini]")) {
          return {
            model,
            modelContextWindowTokens: 128_000,
          };
        }

        if (text.includes("[model: catalog]")) {
          return model;
        }

        if (text.includes("[model: missing]")) {
          return null as never;
        }

        return { model, modelContextWindowTokens: 1_000_000 };
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
