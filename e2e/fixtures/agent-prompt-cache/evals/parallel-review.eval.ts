import assert from "node:assert/strict";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
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
      expectCacheReuse(t, started);
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
        .filter((action) => action.kind === "tool-call" && action.toolName === "reviewer")
        .map(() => `${data.turnId}:${data.stepIndex}`),
    );
  assert.equal(launchSteps.length, 5, "five reviewer requests");
  assert.equal(new Set(launchSteps).size, 1, "all five reviewers launch in one model step");
}

function expectReviewSummary(turn: EveEvalTurn) {
  assert(turn.message?.trim(), "parent reports the completed reviews");
  turn.event("step.completed", { data: { finishReason: "stop" }, count: 1 });
  turn.notEvent("compaction.completed");
}

async function expectParallelReviews(t: EveEvalContext, turn: EveEvalTurn) {
  const calls = turn.events
    .filter((event) => event.type === "subagent.called")
    .filter(({ data }) => data.name === "reviewer");
  const childIds = calls.map(({ data }) => data.childSessionId);
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

function expectHealthyTurn(turn: EveEvalTurn) {
  turn.expectOk();
  turn.noFailedActions();
  turn.notEvent("step.failed");
  turn.notEvent("step.completed", { data: { finishReason: "content-filter" } });
  const steps = turn.events.filter((event) => event.type === "step.started");
  assert(steps.length > 0, "the turn calls a model");
  assert(
    steps.every(({ data }) => data.modelId === process.env.EVE_E2E_MODEL),
    "each request uses the real matrix model",
  );
}

function expectCacheReuse(t: EveEvalContext, turn: EveEvalTurn) {
  const steps = turn.events.filter((event) => event.type === "step.completed");
  assert(steps.length >= 2, "multiple parent requests exercise cache reuse");
  assert(
    (steps[0]?.data.usage?.inputTokens ?? 0) >= 4_096,
    "review packet is large enough for conversation caching",
  );
  for (let index = 1; index < steps.length; index += 1) {
    const previousInput = steps[index - 1]!.data.usage?.inputTokens;
    const usage = steps[index]!.data.usage;
    assert(previousInput !== undefined, "preceding input token usage is present");
    assert(usage?.cacheReadTokens !== undefined, "provider cache-read usage is present");
    t.log(`Parent request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
    // Allow a small margin for differences in provider token counts.
    t.check(
      usage.cacheReadTokens / previousInput,
      satisfies(
        (ratio: number) => ratio >= 0.98,
        `request ${index + 1} reads at least 98% of the preceding input from the provider cache`,
      ),
    );
  }
}

// Keeps the first request above the provider's cache minimum without relying
// on the size of the default tool descriptions.
const EVENT_OVERVIEW = `Event overview: The weekend programme runs on Saturday and Sunday in the ground-floor hall, the studio, and the two meeting rooms beside the garden. Alice coordinates the tutors and volunteers, while Bob manages purchasing, supplier contact, and the shared budget sheet kept in the office. The centre's caretaker opens the building each morning and holds the keys for the storeroom, the side entrance, and the equipment cupboard.

Visitors book workshop places through the front desk or the centre's newsletter. Most sessions are for adults, but the Sunday afternoon drawing workshop welcomes families, so the tutors keep a small box of simpler materials for younger visitors. Volunteers greet arrivals at the main entrance, direct them to the right room, and collect short feedback cards at the end of each session. Tea and water are available in the garden room throughout the day.

The budget for the weekend was agreed at the last committee meeting. It covers materials, equipment hire, printed signs, and a modest amount for refreshments. Bob records each purchase against the budget sheet as soon as an order is confirmed, and Alice reviews the running total every Wednesday. Any change above the agreed amounts needs a short note explaining why it is needed and what it replaces.

Accessibility is part of every room plan. The hall and the studio have step-free access from the side entrance, and the meeting rooms share a ramp from the garden path. Tutors keep one table in each room clear of stools for visitors who use wheelchairs, and printed instructions come in a larger type size on request. The front desk keeps a short list of quiet spaces for anyone who needs a break from the busier sessions.

Supplies arrive in two deliveries. The first comes on Thursday afternoon with paper, paint, clay, and the printed signs, and the caretaker signs for it at the side entrance. The second comes on Friday morning with the hired easels, the portable kiln, and the extra folding tables. Bob checks each delivery against the order confirmation, notes any missing items on the budget sheet, and tells Alice before the end of the day so the tutors can adjust their plans if something is late.

Each workshop has a named tutor and one volunteer helper. The tutor sets up the room before the first session, explains the safety notes for any tools or materials, and keeps an eye on the time so each group finishes promptly. The helper hands out materials, keeps the tables tidy between sessions, and fetches anything the tutor needs from the storeroom. At the end of each day the tutors leave a short note in the office about what went well, what ran short, and anything that should be ordered differently next time.

Planning before the event happens through a shared noticeboard in the office and a weekly email from Alice. The email lists the confirmed workshops, the number of places booked so far, and any changes to rooms or times. Tutors reply with their final materials lists by the Monday before the event, which gives Bob enough time to place the last orders and confirm delivery slots with the suppliers.

After the event, volunteers pack away the reusable materials, count what remains, and label the storeroom shelves so the next programme can start from an accurate inventory. The committee would like each review to be practical and brief, focused on whether the current plan works as written rather than on redesigning the weekend.`;

function reviewPacket(): string {
  const sheets = purchasingSheets
    .map(
      (sheet, index) => `Sheet ${index + 1}: ${sheet.title}\n${sheet.question}\n\n${sheet.notes}`,
    )
    .join("\n\n");
  return `Alice and Bob are preparing a community centre event. Please assign these five sheets to five reviewers so they can work in parallel. Each reviewer has access to the stored sheets and their review questions, so the sheet number is enough for its assignment. Once their findings are available, give Bob a brief summary.\n\n${EVENT_OVERVIEW}\n\n${sheets}`;
}
