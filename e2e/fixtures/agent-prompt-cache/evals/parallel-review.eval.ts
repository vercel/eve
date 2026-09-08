import { defineEval, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { purchasingSheets } from "../purchasing-sheets";

const reviewSchema = z.object({
  sheet: z.number().int().min(1).max(5),
  startedAt: z.number(),
  completedAt: z.number(),
});

export default [false, true].map((laterTurn) =>
  defineEval({
    tags: ["real-model"],
    description: `Real provider cache hits survive five parallel reviews (${laterTurn ? "later" : "first"} turn).`,
    async test(t) {
      if (laterTurn) {
        const planning = await t.send(
          "Eight workshops have twelve places each. How many places is that in total?",
        );
        planning.expectOk();
        planning.messageIncludes("96");
        planning.event("actions.requested", { count: 0 });
        planning.event("step.completed", {
          data: (data) => data.finishReason === "content-filter",
          count: 0,
        });
      }

      const started = await t.send(reviewPacket());
      started.expectOk();
      started.calledSubagent("reviewer", { count: 5 });
      started.eventsSatisfy("five reviewers launch in one model step", (events) => {
        const steps = events.flatMap((event) =>
          event.type === "actions.requested"
            ? event.data.actions
                .filter((action) => action.kind === "tool-call" && action.toolName === "reviewer")
                .map(() => `${event.data.turnId}:${event.data.stepIndex}`)
            : [],
        );
        return steps.length === 5 && new Set(steps).size === 1;
      });
      const taskIds = started.events.flatMap((event) =>
        event.type === "subagent.completed" && event.data.backgroundTask !== undefined
          ? [event.data.backgroundTask.taskId]
          : [],
      );
      await t.require(
        taskIds,
        satisfies(
          (ids: typeof taskIds) => ids.length === 5 && new Set(ids).size === 5,
          "five distinct tasks",
        ),
      );

      const turns = [started];
      let session: Pick<EveEvalSession, "state"> = t;
      for (let attempt = 0; attempt < 10 && !allCompleted(turns, taskIds); attempt += 1) {
        const startIndex = session.state?.streamIndex;
        if (startIndex === undefined) throw new Error("Parent stream cursor is missing.");
        const live = t.target.watchTurn(started.sessionId, { startIndex });
        const turn = await live.result();
        turn.expectOk();
        turns.push(turn);
        session = live.session;
      }
      await t.require(
        allCompleted(turns, taskIds),
        satisfies(Boolean, "all five completion notifications reach the parent"),
      );
      await t.require(
        turns.length,
        satisfies((count: number) => count > 1, "background completion wakes the parent"),
      );
      const final = turns.at(-1)!;
      await t.require(
        final.message,
        satisfies(
          (message: string | undefined) => message !== undefined && message.trim().length > 0,
          "parent reports the completed reviews",
        ),
      );
      final.event("step.completed", {
        data: (data) => data.finishReason === "stop",
        count: 1,
      });

      const parentEvents = turns.flatMap((turn) => turn.events);
      const calls = parentEvents.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "reviewer" ? [event.data] : [],
      );
      await t.require(
        calls,
        satisfies(
          (values: typeof calls) =>
            values.length === 5 && new Set(values.map((call) => call.childSessionId)).size === 5,
          "five distinct child sessions without repeated delegation",
        ),
      );
      const children = await Promise.all(
        calls.map((call) => t.target.watchTurn(call.childSessionId).result()),
      );
      const intervals = children.map((child) => {
        child.expectOk();
        child.calledTool("review_sheet", { count: 1 });
        child.noFailedActions();
        child.event("step.failed", { count: 0 });
        child.event("step.completed", {
          data: (data) => data.finishReason === "content-filter",
          count: 0,
        });
        child.eventsSatisfy("reviewer uses the real matrix model", usesMatrixModel);
        return reviewSchema.parse(
          child.toolCalls.find((call) => call.name === "review_sheet")?.output,
        );
      });
      await t.require(
        intervals,
        satisfies(
          (values: typeof intervals) =>
            new Set(values.map((value) => value.sheet)).size === 5 &&
            Math.max(...values.map((value) => value.startedAt)) <
              Math.min(...values.map((value) => value.completedAt)),
          "all five sheet reviews overlap",
        ),
      );
      for (const turn of turns) {
        turn.noFailedActions();
        turn.eventsSatisfy("parent uses the real matrix model", usesMatrixModel);
        turn.event("compaction.completed", { count: 0 });
        turn.event("step.failed", { count: 0 });
        turn.event("step.completed", {
          data: (data) => data.finishReason === "content-filter",
          count: 0,
        });
      }

      const completed = parentEvents.filter((event) => event.type === "step.completed");
      await t.require(
        completed.length,
        satisfies((count: number) => count >= 3, "multiple parent requests exercise cache reuse"),
      );
      const firstInputTokens = completed[0]?.data.usage?.inputTokens;
      await t.require(
        firstInputTokens,
        satisfies(
          (tokens: number | undefined) => tokens !== undefined && tokens >= 4_096,
          "review packet is large enough to exercise conversation caching",
        ),
      );
      // Allow cache block rounding while requiring reuse of the conversation, not just the system prompt.
      for (let index = 1; index < completed.length; index += 1) {
        const previousInput = completed[index - 1]!.data.usage?.inputTokens;
        const usage = completed[index]!.data.usage;
        t.log(`Parent request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
        t.check(
          usage?.cacheReadTokens,
          satisfies(
            (cached: number | undefined) =>
              cached !== undefined && previousInput !== undefined && cached >= previousInput * 0.9,
            `request ${index + 1} reads at least 90% of the preceding input from the provider cache`,
          ),
        );
      }
    },
  }),
);

function allCompleted(turns: readonly EveEvalTurn[], taskIds: readonly string[]): boolean {
  return taskIds.every((taskId) =>
    turns.some((turn) =>
      turn.events.some(
        (event) =>
          event.type === "message.received" &&
          typeof event.data.message === "string" &&
          event.data.message.includes(`Background task ${taskId} (`) &&
          event.data.message.includes(" is completed."),
      ),
    ),
  );
}

function usesMatrixModel(events: EveEvalTurn["events"]): boolean {
  const steps = events.filter((event) => event.type === "step.started");
  return (
    steps.length > 0 && steps.every((event) => event.data.modelId === process.env.EVE_E2E_MODEL)
  );
}

function reviewPacket(): string {
  const sheets = purchasingSheets
    .map(
      (sheet, index) => `Sheet ${index + 1}: ${sheet.title}\n${sheet.question}\n\n${sheet.notes}`,
    )
    .join("\n\n");
  return `Alice and Bob are preparing a community centre event. Please assign these five sheets to five reviewers so they can work in parallel. Give each reviewer its sheet number and the question for that sheet. Let Alice know when the reviews are underway, then give Bob a brief summary once their findings are available.\n\n${sheets}`;
}
