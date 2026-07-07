import { defineEval } from "eve/evals";

/**
 * No selection marker: the resolver returns `null`, the fallback serves the
 * turn, and the runtime identity reports `dynamic:<fallback id>`.
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
