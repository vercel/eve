import { randomUUID } from "node:crypto";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { agentEvalTags, requireDeliveredText } from "@evals/agent/shared";
import { saveWorkstreamSchema } from "@shared/workstreams/schema";

export default [
  defineEval({
    description:
      "Continues an ongoing undertaking in a new session with corrected constraints",
    tags: [...agentEvalTags, "workstreams"],
    async test(t) {
      const title = `Test trip ${randomUUID()}`;
      let id: string | undefined;
      try {
        const first = await t.send(
          `Help me keep track of ${title} across conversations. This is a fictional train trip; do not search or book anything. We have two options, 09:00 and 11:00. I want a window seat. I still need to decide the departure. Remember this as ongoing work, not a general preference.`
        );
        first.expectOk();
        first.succeeded();
        id = saveWorkstreamSchema.parse(
          first.requireToolCall("workstreams__save", { status: "completed" })
            .input
        ).id;
        first.notCalledTool("profile__save_memory");

        const correction = await first.session.send(
          `For ${title}, change my seat requirement to aisle. Keep both departure options and the pending decision. This correction applies only to this trip.`
        );
        correction.expectOk();
        correction.succeeded();
        correction.calledTool("workstreams__save");

        const later = await t.send(
          `Let's continue ${title}. Which departures were we considering, what seat do I want, and what remains undecided? Do not search or book.`
        );
        later.expectOk();
        later.succeeded();
        later.calledTool("workstreams__read");
        const text = await requireDeliveredText(t, later);
        t.check(text, includes(/aisle/iu));
        t.check(text, includes(/(?:0?9(?::00)?|nine)/iu));
        t.check(text, includes(/(?:11(?::00)?|eleven)/iu));
        later.notCalledTool("schedules-create");
        later.notCalledTool("run_browser");
      } finally {
        if (id) {
          const cleanup = await t.send(
            `Forget the workstream with id ${id}. Read its current revision and remove it from workstream memory.`
          );
          cleanup.expectOk();
          cleanup.calledTool("workstreams__forget", { count: 1 });
        }
      }
    },
  }),
  defineEval({
    description: "Does not turn a one-off question into an undertaking",
    tags: [...agentEvalTags, "workstreams"],
    async test(t) {
      const turn = await t.send(
        "What is 19 plus 23? Please do not save this conversation as a workstream."
      );
      turn.expectOk();
      turn.succeeded();
      turn.notCalledTool("workstreams__save");
      t.check(await requireDeliveredText(t, turn), includes("42"));
    },
  }),
];
