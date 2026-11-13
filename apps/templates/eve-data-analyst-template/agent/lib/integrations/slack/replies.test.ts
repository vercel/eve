import type { SlackThread } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { beforeEach, expect, it, vi } from "vitest";

import { recordQuery } from "../../analyst/query-log";
import { recordThreadRole } from "../../analyst/thread-roles";
import { sessionContext, slackAuth } from "../../testing/session";
import {
  messageCompletedHarness,
  slackEventContext,
} from "../../testing/slack";
import { testState, installTestState } from "../../testing/state";
import { replyDelivery, replyEvents, THREAD_ROLE_NOTICE } from "./replies";
import {
  recordVisualizationDelivery,
  visualizationReceipts,
} from "./visualizations/receipts";

beforeEach(() => testState.reset());

it("suppresses duplicate prose after a successful visualization", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
});

it("keeps the normal response after any failed visualization", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordVisualizationDelivery("turn-1", true);
  recordVisualizationDelivery("turn-1", false);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("does not suppress later turns", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordVisualizationDelivery("older-turn", true);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("defers tool-call narration to eve without touching reply state", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  harness.channel.state.pendingToolCallMessage = "Checking the warehouse.";
  recordVisualizationDelivery("turn-1", true);
  await harness.complete({ finishReason: "tool-calls" });
  expect(harness.next).toHaveBeenCalledOnce();
  expect(harness.channel.state.pendingToolCallMessage).toBe(
    "Checking the warehouse."
  );
  expect(visualizationReceipts.get()).toEqual({
    failed: false,
    posted: true,
    turnId: "turn-1",
  });
});

it("clears buffered narration when a final reply is suppressed", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  harness.channel.state.pendingToolCallMessage = "Checking the warehouse.";
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
  expect(harness.channel.state.pendingToolCallMessage).toBeNull();
});

const query = {
  purpose: "MRR at the end of September",
  ranAt: "2026-10-10T09:14:00.000Z",
  sql: "SELECT sum(mrr_cents) FROM subscriptions",
  tables: ["analytics.subscriptions", "analytics.customers"],
};

it("posts the reply with a folded SQL section when the turn ran queries", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordQuery("turn-1", query);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledExactlyOnceWith(harness.channel, {
    blocks: [
      { text: "Here is the result.", type: "markdown" },
      expect.objectContaining({ default_collapsed: true, type: "container" }),
    ],
    markdown: expect.stringContaining(
      "```sql\nSELECT sum(mrr_cents) FROM subscriptions\n```"
    ),
    text: "Here is the result.",
  });
});

it("leaves replies without queries to eve's default", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordQuery("older-turn", query);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
  expect(deliver).not.toHaveBeenCalled();
});

it("lets delivery failures reach eve's notice instead of posting twice", async () => {
  vi.spyOn(replyDelivery, "post").mockRejectedValue(new Error("invalid_auth"));
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  recordQuery("turn-1", query);
  await expect(harness.complete()).rejects.toThrow("invalid_auth");
  expect(harness.next).not.toHaveBeenCalled();
});

const turnCancelled = replyEvents["turn.cancelled"];

const alice = slackAuth({ userId: "U0ALICE" });

/* Records results fetched as Alice's own role, so the default-role caller conflicts. */
const holdFinanceResults = () => {
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
  recordThreadRole(alice);
};

/* Runs the cancelled-turn renderer for a turn, observing posts and the rest of the chain. */
const cancelTurn = (
  turnId: string,
  post?: () => Promise<Awaited<ReturnType<SlackThread["post"]>>>,
  current: SessionAuthContext = slackAuth()
) => {
  const channel = slackEventContext(post ? { thread: { post } } : {});
  const next = vi.fn(() => Promise.resolve());
  const run = turnCancelled(
    { sequence: 7, turnId },
    channel,
    sessionContext({ current }),
    next
  );
  return { channel, next, run };
};

it("posts the start-a-new-thread notice when the caller's role conflicts", async () => {
  holdFinanceResults();
  const { channel, next, run } = cancelTurn("turn-2");
  await run;
  expect(channel.thread.post).toHaveBeenCalledExactlyOnceWith(
    THREAD_ROLE_NOTICE
  );
  expect(next).toHaveBeenCalledOnce();
});

it("leaves other cancelled turns to eve's default", async () => {
  holdFinanceResults();
  const { channel, next, run } = cancelTurn("turn-3", undefined, alice);
  await run;
  expect(channel.thread.post).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});

it("still runs eve's default when the notice fails to post", async () => {
  holdFinanceResults();
  const { next, run } = cancelTurn("turn-2", () =>
    Promise.reject(new Error("invalid_auth"))
  );
  await expect(run).rejects.toThrow("invalid_auth");
  expect(next).toHaveBeenCalledOnce();
});

it("posts the notice once when eve replays the cancellation", async () => {
  holdFinanceResults();
  const first = cancelTurn("turn-2");
  await first.run;
  const replay = cancelTurn("turn-2");
  await replay.run;
  expect(first.channel.thread.post).toHaveBeenCalledOnce();
  expect(replay.channel.thread.post).not.toHaveBeenCalled();
  expect(replay.next).toHaveBeenCalledOnce();
});

it("keeps no receipt when Slack doesn't confirm the notice", async () => {
  holdFinanceResults();
  const refused = cancelTurn("turn-2", () =>
    Promise.resolve({ id: "", raw: { error: "invalid_auth", ok: false } })
  );
  await expect(refused.run).rejects.toThrow("thread role notice");
  expect(refused.next).toHaveBeenCalledOnce();
  const thrown = cancelTurn("turn-2", () =>
    Promise.reject(new Error("socket hang up"))
  );
  await expect(thrown.run).rejects.toThrow("socket hang up");
  const retry = cancelTurn("turn-2");
  await retry.run;
  expect(retry.channel.thread.post).toHaveBeenCalledExactlyOnceWith(
    THREAD_ROLE_NOTICE
  );
});

beforeEach(installTestState);
