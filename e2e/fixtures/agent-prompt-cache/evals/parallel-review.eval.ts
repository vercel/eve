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
      if (launchTurn === "later") {
        const planning = await t.send(
          "Eight workshops have twelve places each. How many places is that in total?",
        );
        expectHealthyTurn(planning);
        planning.messageIncludes("96");
        planning.notEvent("actions.requested");
      }

      const started = await t.send(reviewPacket());
      const taskIds = expectFiveReviewers(started);
      const turns = await waitForReviews(t, started, taskIds);
      await expectParallelReviews(t, turns);
      expectCacheReuse(t, turns);
    },
  }),
);

function expectFiveReviewers(started: EveEvalTurn) {
  expectHealthyTurn(started);
  started.calledSubagent("reviewer", { count: 5 });
  const launchSteps = started.events
    .filter((event) => event.type === "actions.requested")
    .flatMap(({ data }) =>
      data.actions
        .filter((action) => action.kind === "tool-call" && action.toolName === "reviewer")
        .map(() => `${data.turnId}:${data.stepIndex}`),
    );
  assert.equal(launchSteps.length, 5, "five reviewer requests");
  assert.equal(new Set(launchSteps).size, 1, "all five reviewers launch in one model step");

  const taskIds = started.events
    .filter((event) => event.type === "subagent.completed")
    .flatMap(({ data }) => (data.backgroundTask ? [data.backgroundTask.taskId] : []));
  assert.equal(taskIds.length, 5, "five background task receipts");
  assert.equal(new Set(taskIds).size, 5, "five distinct background tasks");
  return taskIds;
}

async function waitForReviews(t: EveEvalContext, started: EveEvalTurn, taskIds: string[]) {
  const turns = [started];
  let cursor = t.state?.streamIndex;
  for (let attempt = 0; attempt < 10 && !allCompleted(turns, taskIds); attempt += 1) {
    assert(cursor !== undefined, "parent stream cursor is present");
    const live = t.target.watchTurn(started.sessionId, { startIndex: cursor });
    const turn = await live.result();
    expectHealthyTurn(turn);
    turns.push(turn);
    cursor = live.session.state?.streamIndex;
  }
  assert(allCompleted(turns, taskIds), "all five completion notifications reach the parent");
  assert(turns.length > 1, "background completion wakes the parent");
  const final = turns.at(-1)!;
  assert(final.message?.trim(), "parent reports the completed reviews");
  final.event("step.completed", { data: { finishReason: "stop" }, count: 1 });
  for (const turn of turns) turn.notEvent("compaction.completed");
  return turns;
}

function allCompleted(turns: EveEvalTurn[], taskIds: string[]) {
  const messages = turns
    .flatMap((turn) => turn.events)
    .filter((event) => event.type === "message.received")
    .map(({ data }) => data.message);
  return taskIds.every((id) =>
    messages.some(
      (message) =>
        message.includes(`Background task ${id} (`) && message.includes(" is completed."),
    ),
  );
}

async function expectParallelReviews(t: EveEvalContext, turns: EveEvalTurn[]) {
  const calls = turns
    .flatMap((turn) => turn.events)
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

function expectCacheReuse(t: EveEvalContext, turns: EveEvalTurn[]) {
  const steps = turns
    .flatMap((turn) => turn.events)
    .filter((event) => event.type === "step.completed");
  assert(steps.length >= 3, "multiple parent requests exercise cache reuse");
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
    // Allow cache block rounding while requiring reuse of the conversation, not just the system prompt.
    t.check(
      usage.cacheReadTokens / previousInput,
      satisfies(
        (ratio: number) => ratio >= 0.9,
        `request ${index + 1} reads at least 90% of the preceding input from the provider cache`,
      ),
    );
  }
}

function reviewPacket(): string {
  const sheets = purchasingSheets
    .map(
      (sheet, index) => `Sheet ${index + 1}: ${sheet.title}\n${sheet.question}\n\n${sheet.notes}`,
    )
    .join("\n\n");
  return `Alice and Bob are preparing a community centre event. Please assign these five sheets to five reviewers so they can work in parallel. Each reviewer has access to the stored sheets and their review questions, so the sheet number is enough for its assignment. Let Alice know when the reviews are underway, then give Bob a brief summary once their findings are available.\n\n${sheets}`;
}
