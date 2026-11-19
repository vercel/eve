import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

const preferenceCanary = "quiet-car preference on train trips";

export default [
  defineEval({
    description: "Recalls a stable preference in a separate session",
    tags: [...agentEvalTags, "memory"],
    async test(t) {
      let evaluationError: Error | undefined;
      try {
        const first = await t.send(
          `Remember this exact preference for future trips: ${preferenceCanary}.`
        );
        first.expectOk();
        first.succeeded();
        first.calledTool("profile__save_memory", { count: 1 });
        await requireDeliveredText(t, first);

        const laterSession = await t.session();
        const later = await laterSession.send(
          "What seating preference have I told you to use for train trips?"
        );
        later.expectOk();
        later.succeeded();
        const text = await requireDeliveredText(t, later);
        t.check(text, includes(/quiet.?car/iu));
        assertPlainTextDelivery(t, text);
      } catch (error) {
        evaluationError =
          error instanceof Error
            ? error
            : new Error("Memory evaluation failed with a non-Error value.", {
                cause: error,
              });
      }

      let cleanupError: Error | undefined;
      try {
        const cleanupSession = await t.session();
        const cleanup = await cleanupSession.send(
          `Use profile__remove_memory to forget this exact preference: ${preferenceCanary}.`
        );
        cleanup.expectOk();
        cleanup.succeeded();
        cleanup.calledTool("profile__remove_memory", { count: 1 });
        await requireDeliveredText(t, cleanup);
      } catch (error) {
        cleanupError =
          error instanceof Error
            ? error
            : new Error("Memory cleanup failed with a non-Error value.", {
                cause: error,
              });
      }

      if (evaluationError && cleanupError) {
        throw new AggregateError(
          [evaluationError, cleanupError],
          "Memory evaluation and canary cleanup both failed."
        );
      }
      if (evaluationError) throw evaluationError;
      if (cleanupError) throw cleanupError;
    },
  }),
  defineEval({
    description: "Does not save an explicitly one-off preference",
    tags: [...agentEvalTags, "memory", "smoke"],
    async test(t) {
      const turn = await t.send(
        "For today only, I want sparkling water with lunch. Do not save that as a preference."
      );
      turn.expectOk();
      turn.succeeded();
      turn.notCalledTool("profile__save_memory");
      turn.notCalledTool("personal_info__update");
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
    },
  }),
];
