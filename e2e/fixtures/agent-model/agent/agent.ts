import { defineAgent, defineDynamic, type DynamicResolveContext } from "eve";

const model = process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol";

/**
 * Dynamic-model e2e fixture. Resolves at `turn.started` (not the usual
 * `session.started`) so one session can exercise selection, null fallback,
 * and resolver-failure degradation.
 */
export default defineAgent({
  model: defineDynamic({
    fallback: model,
    events: {
      "turn.started": (_event, ctx) => {
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

        return null;
      },
    },
  }),
});

function lastUserText(messages: DynamicResolveContext["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  }
  return "";
}
