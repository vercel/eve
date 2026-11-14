import type { SlackThread } from "eve/channels/slack";
import { beforeEach, expect, it, vi } from "vitest";

import { recordQuery } from "../../analyst/query-log";
import { recordThreadRole } from "../../analyst/thread-roles";
import { sessionContext, slackAuth } from "../../testing/session";
import {
  messageCompletedHarness,
  slackEventContext,
  channelEventContext,
} from "../../testing/slack";
import { testState, installTestState } from "../../testing/state";
import { replyDelivery, replyEvents, THREAD_ROLE_NOTICE } from "./replies";
import { recordVisualizationDelivery } from "./visualizations/receipts";

beforeEach(() => {
  testState.reset();
  installTestState();
});

it("suppresses duplicate prose after a successful visualization but not after failures", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
  recordVisualizationDelivery("turn-1", false);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
});
it("leaves other turns and narration to eve", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("older-turn", true);
  await harness.complete();
  recordVisualizationDelivery("turn-1", true);
  await harness.complete({
    data: {
      kind: "text",
      partId: "narration",
      phase: "narration",
      value: "Checking the warehouse.",
    },
  });
  expect(harness.next).toHaveBeenCalledTimes(2);
});
const query = {
  purpose: "MRR",
  ranAt: "2026-10-10T09:14:00.000Z",
  sql: "SELECT sum(mrr_cents) FROM subscriptions",
  tables: ["analytics.subscriptions"],
};
it("posts the reply with exact executed SQL through eve's delivery fallbacks", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
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
it("does not attach a previous turn's SQL", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordQuery("older-turn", query);
  await harness.complete();
  expect(deliver).not.toHaveBeenCalled();
  expect(harness.next).toHaveBeenCalledOnce();
});
it("propagates reply delivery failure instead of posting twice", async () => {
  vi.spyOn(replyDelivery, "post").mockRejectedValue(new Error("invalid_auth"));
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordQuery("turn-1", query);
  await expect(harness.complete()).rejects.toThrow("invalid_auth");
  expect(harness.next).not.toHaveBeenCalled();
});
const alice = slackAuth({ userId: "U0ALICE" });
const holdFinanceResults = () => {
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
  recordThreadRole(alice);
};
const cancelTurn = (
  post?: SlackThread["post"],
  current = slackAuth(),
  outcome: "completed" | "cancelled" = "cancelled"
) => {
  const channel = slackEventContext(post ? { thread: { post } } : {});
  const next = vi.fn(() => Promise.resolve());
  const run = replyEvents["turn.settled"](
    { data: { outcome, turnId: "turn-2" }, type: "turn.settled" },
    { ...channelEventContext(channel), ...sessionContext({ current }) },
    next
  );
  return { channel, next, run };
};
it("posts one role-conflict notice across cancellation replays", async () => {
  holdFinanceResults();
  const first = cancelTurn();
  await first.run;
  const replay = cancelTurn();
  await replay.run;
  expect(first.channel.thread.post).toHaveBeenCalledExactlyOnceWith(
    THREAD_ROLE_NOTICE
  );
  expect(replay.channel.thread.post).not.toHaveBeenCalled();
  expect(replay.next).toHaveBeenCalledOnce();
});
it("does not post a role notice for an allowed caller or completed turn", async () => {
  holdFinanceResults();
  const allowed = cancelTurn(undefined, alice);
  await allowed.run;
  const completed = cancelTurn(undefined, slackAuth(), "completed");
  await completed.run;
  expect(allowed.channel.thread.post).not.toHaveBeenCalled();
  expect(completed.channel.thread.post).not.toHaveBeenCalled();
});
it("keeps native cleanup and permits retry when notice delivery fails", async () => {
  holdFinanceResults();
  const failed = cancelTurn(() =>
    Promise.resolve({ id: "", raw: { ok: false } })
  );
  await expect(failed.run).rejects.toThrow("thread role notice");
  expect(failed.next).toHaveBeenCalledOnce();
  const retry = cancelTurn();
  await retry.run;
  expect(retry.channel.thread.post).toHaveBeenCalledExactlyOnceWith(
    THREAD_ROLE_NOTICE
  );
});
