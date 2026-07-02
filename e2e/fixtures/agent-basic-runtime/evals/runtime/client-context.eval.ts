import { defineEval } from "eve/evals";

const CLIENT_CONTEXT_TOKEN = "clientctx-ok-W7R2";

/**
 * Core session-route runtime behavior: per-turn client context delivery.
 *
 * clientContext strings become user-role context messages ahead of the
 * turn message. The prompt directs the model to echo an exact token from
 * the current turn's user batch, so the reply proves delivery.
 */
export default defineEval({
  description: "Session runtime smoke: client context.",

  async test(t) {
    await t.send({
      clientContext: [`include the exact token ${CLIENT_CONTEXT_TOKEN} verbatim`],
      message: "Say hello.",
    });

    t.succeeded();
    t.messageIncludes(CLIENT_CONTEXT_TOKEN);
  },
});
