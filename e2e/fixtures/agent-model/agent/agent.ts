import { defineAgent, defineDynamic, type DynamicResolveContext } from "eve";

/**
 * Dynamic-model e2e fixture.
 *
 * The resolver runs at `turn.started` so the evals can exercise per-turn
 * selection, null fallback, and resolver-failure degradation in one session.
 * Real agents should usually resolve at `session.started` — see the
 * dynamic-capabilities guide for the prompt-cache implications of switching
 * models mid-session.
 */
export default defineAgent({
  model: defineDynamic({
    fallback: "openai/gpt-5.5",
    events: {
      "turn.started": (_event, ctx) => {
        const text = lastUserText(ctx.messages);

        if (text.includes("[model: boom]")) {
          // Exercised by resolver-failure.eval.ts: a throwing resolver must
          // degrade to the fallback model, not fail the turn.
          throw new Error("intentional resolver failure");
        }

        if (text.includes("[model: mini]")) {
          return {
            model: "openai/gpt-5.5-mini",
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
