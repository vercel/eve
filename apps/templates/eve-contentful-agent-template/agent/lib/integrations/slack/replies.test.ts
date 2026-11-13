import { beforeEach, expect, it } from "vitest";

import { messageCompletedHarness } from "../../testing/slack";
import { testState, installTestState } from "../../testing/state";
import { replyEvents } from "./replies";
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
  harness.channel.state.pendingToolCallMessage = "Checking the guides.";
  recordVisualizationDelivery("turn-1", true);
  await harness.complete({ finishReason: "tool-calls" });
  expect(harness.next).toHaveBeenCalledOnce();
  expect(harness.channel.state.pendingToolCallMessage).toBe(
    "Checking the guides."
  );
  expect(visualizationReceipts.get()).toEqual({
    failed: false,
    posted: true,
    turnId: "turn-1",
  });
});
it("clears buffered narration when a final reply is suppressed", async () => {
  const harness = messageCompletedHarness(replyEvents["message.completed"]);
  harness.channel.state.pendingToolCallMessage = "Checking the guides.";
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
  expect(harness.channel.state.pendingToolCallMessage).toBeNull();
});

beforeEach(installTestState);
