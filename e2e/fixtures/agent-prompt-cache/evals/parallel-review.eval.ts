import assert from "node:assert/strict";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { z } from "zod";
import { expectCacheReuse, expectHealthyTurn } from "../cache-checks";
import { EVENT_OVERVIEW } from "../event-overview";
import { purchasingSheets } from "../purchasing-sheets";

const reviewSchema = z.object({
  sheet: z.number().int().min(1).max(5),
  startedAt: z.number(),
  completedAt: z.number(),
});

export default ["first", "later"].map((launchTurn) =>
  defineEval({
    tags: ["real-model"],
    description: `Real provider cache hits survive five parallel reviews (${launchTurn} turn).`,
    async test(t) {
      const session = await t.session();
      if (launchTurn === "later") {
        const planning = await session.send(
          "Alice is planning a community centre event with eight workshops and twelve places per workshop. " +
            "Please calculate the total number of places. Bob is preparing the purchasing sheets and will send them next for review.",
        );
        expectHealthyTurn(planning);
        planning.messageIncludes("96");
        planning.notEvent("actions.requested");
      }

      const started = await session.send(
        launchTurn === "later"
          ? `Bob has the purchasing sheets ready for the event we just discussed.\n\n${reviewPacket()}`
          : reviewPacket(),
      );
      expectFiveReviewers(started);
      expectReviewSummary(started);
      await expectParallelReviews(t, started);
      expectCacheReuse(t, [started]);
    },
  }),
);

function expectFiveReviewers(started: EveEvalTurn) {
  expectHealthyTurn(started);
  started.calledSubagent("reviewer", { status: "completed", count: 5 });
  const launchSteps = started.events
    .filter((event) => event.type === "actions.requested")
    .flatMap(({ data }) =>
      data.actions
        .filter((action) => action.kind === "subagent-call" && action.subagentName === "reviewer")
        .map(() => `${data.turnId}:${data.stepIndex}`),
    );
  assert.equal(launchSteps.length, 5, "five reviewer requests");
  assert.equal(new Set(launchSteps).size, 1, "all five reviewers launch in one model step");
}

function expectReviewSummary(turn: EveEvalTurn) {
  assert(turn.message?.trim(), "parent reports the completed reviews");
  // The task prompt lets the parent tell the person the reviews have started before the summary.
  turn.event("step.completed", {
    data: { finishReason: "stop" },
    count: (count) => count === 1 || count === 2,
  });
  turn.notEvent("compaction.completed");
}

async function expectParallelReviews(t: EveEvalContext, turn: EveEvalTurn) {
  const sessions = turn.events
    .filter((event) => event.type === "agent.started")
    .filter(({ data }) => data.name === "reviewer");
  const childIds = sessions.map(({ data }) => data.sessionId);
  assert.equal(childIds.length, 5, "no repeated delegation");
  assert.equal(new Set(childIds).size, 5, "five distinct child sessions");
  const children = await Promise.all(childIds.map((id) => t.target.watchTurn(id).result()));
  const reviews = children.map((child) => {
    expectHealthyTurn(child);
    return reviewSchema.parse(child.requireToolCall("review_sheet").output);
  });
  assert.equal(new Set(reviews.map((review) => review.sheet)).size, 5, "all five sheets reviewed");
  const lastStarted = Math.max(...reviews.map((review) => review.startedAt));
  const firstFinished = Math.min(...reviews.map((review) => review.completedAt));
  assert(lastStarted < firstFinished, "all five reviews overlap");
}

function reviewPacket(): string {
  const sheets = purchasingSheets
    .map(
      (sheet, index) => `Sheet ${index + 1}: ${sheet.title}\n${sheet.question}\n\n${sheet.notes}`,
    )
    .join("\n\n");
  return `Alice and Bob are preparing a community centre event. Please assign these five sheets to five reviewers so they can work in parallel. Each reviewer has access to the stored sheets and their review questions, so the sheet number is enough for its assignment. Once their findings are available, give Bob a brief summary.\n\n${EVENT_OVERVIEW}\n\n${sheets}`;
}
