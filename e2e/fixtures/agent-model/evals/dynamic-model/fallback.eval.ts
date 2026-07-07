import { defineEval } from "eve/evals";

/**
 * Dynamic-model smoke: with no selection marker the resolver returns `null`,
 * so the compiled `fallback` model serves the turn, and the runtime identity
 * on `session.started` reports the model as `dynamic:<fallback id>`.
 */
export default defineEval({
  description: "Dynamic model smoke: null selection serves the fallback model.",
  async test(t) {
    await t.send('Reply with exactly the text "fallback ping" and nothing else.');

    t.succeeded();
    t.messageIncludes("fallback ping");
    t.usedNoTools();
    t.eventsSatisfy("runtime identity reports a dynamic model", (events) =>
      events.some(
        (event) =>
          event.type === "session.started" &&
          event.data.runtime?.modelId === "dynamic:openai/gpt-5.5",
      ),
    );
  },
});
