import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineEval, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { promptRecordSchema, promptRecordsPath } from "../prompt-records";

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
      if (laterTurn)
        (await t.send("Alice will send a purchasing packet shortly. Say ready.")).expectOk();

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
      final.messageIncludes("REVIEW_COMPLETE");
      for (let sheet = 1; sheet <= 5; sheet += 1) final.messageIncludes(`SHEET_REVIEWED_${sheet}`);

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
      }

      const completed = parentEvents.filter((event) => event.type === "step.completed");
      const records = readFileSync(promptRecordsPath(started.sessionId), "utf8")
        .trim()
        .split("\n")
        .map((line) => promptRecordSchema.parse(JSON.parse(line)))
        .filter((record) =>
          completed.some(
            (event) =>
              event.data.turnId === record.turnId && event.data.stepIndex === record.stepIndex,
          ),
        );
      await t.require(
        records.length,
        satisfies(
          (count: number) => count === completed.length && count >= 3,
          "capture every parent model request",
        ),
      );
      for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1]!;
        const current = records[index]!;
        t.check(
          current,
          satisfies(
            (record: typeof current) =>
              record.instructions === previous.instructions &&
              previous.messages.every((message, offset) => message === record.messages[offset]),
            `request ${index + 1} preserves the preceding prompt prefix`,
          ),
        );
      }

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
  const products = [
    "stackable storage boxes",
    "recycled paper notebooks",
    "packing tape rolls",
    "cotton cleaning cloths",
    "cardboard mailing tubes",
    "adjustable shelf dividers",
    "reusable water bottles",
    "clipboards with covers",
    "wooden sorting trays",
    "coloured index cards",
    "document folders",
    "cork notice boards",
    "paper label sheets",
    "desk organisers",
    "felt protective pads",
    "reusable shopping bags",
    "pencil sharpeners",
    "spiral planning books",
    "magnetic page markers",
    "small parts containers",
  ];
  const notes = [
    "Match the colour to the sample approved at the last purchasing meeting.",
    "Keep the manufacturer's care instructions with the delivery paperwork.",
    "Count the individual units before putting the outer packaging aside.",
    "Check that the carton label and the packing slip list the same quantity.",
    "Place the delivery on the labelled shelf beside the receiving desk.",
    "Record any damaged packaging on the receiving form before unpacking.",
    "Ask the receiving coordinator to confirm the preferred storage position.",
    "Retain one sample for Bob to compare with the next scheduled delivery.",
  ];
  const records = Array.from({ length: 5 }, (_, sheet) =>
    [
      `Sheet ${sheet + 1}: receiving area ${sheet + 1}`,
      "Entry | Product | Quantity | Unit price (cents) | Delivery date | Receiving note",
      ...Array.from(
        { length: 40 },
        (_, item) =>
          `${item + 1} | ${products[(item + sheet * 3) % products.length]} | ${12 + item * 2} | ${150 + item * 37} | October ${(item % 20) + 1} | ${notes[(item + sheet) % notes.length]}`,
      ),
    ].join("\n"),
  ).join("\n\n");
  return `Purchasing packet ${randomUUID()}.\nAlice has five independent purchasing sheets for Bob's team. Launch five reviewer subagents in parallel, one per sheet, and collect their results. Send each reviewer only its sheet number; the review_sheet tool has the corresponding records. Acknowledge admission briefly while they work. Report REVIEW_COMPLETE and all five SHEET_REVIEWED markers once their completion notifications arrive.\n\n${records}`;
}
