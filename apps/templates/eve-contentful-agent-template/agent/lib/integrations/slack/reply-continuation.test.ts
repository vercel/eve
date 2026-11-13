import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it } from "vitest";

import { sessionContext } from "../../testing/session";
import { installTestState, testState } from "../../testing/state";
import hook from "./reply-continuation";
import { visualizationReceipts } from "./visualizations/receipts";

const inputResolved = hook.events?.["input.resolved"];
const turnStarted = hook.events?.["turn.started"];
if (!(inputResolved && turnStarted)) {
  throw new Error("Expected input.resolved and turn.started handlers.");
}

type Resolution = HookEvent<"input.resolved">["data"]["resolutions"][number];

/* Hook context for a session bound to the given channel kind. */
const hookContext = (kind = "channel:slack"): HookContext => ({
  ...sessionContext(),
  agent: { name: "test" },
  cancel: () => {},
  channel: { kind },
});

/* The answer recorded when a user chooses to continue past the session limit. */
const continueAnswer: Resolution = {
  kind: "session-limit",
  outcome: "answered",
  requestId: "limit-1",
  response: { optionId: "continue", requestId: "limit-1" },
};

/* Stream metadata eve stamps on every recorded event. */
const meta = { at: "2026-10-10T00:00:00.000Z", id: "event-1" };

/* Input resolution recorded for the source turn "turn-1". */
const resolvedEvent = (
  resolutions: Resolution[]
): HookEvent<"input.resolved"> => ({
  data: { resolutions, sequence: 5, stepIndex: 1, turnId: "turn-1" },
  meta,
  type: "input.resolved",
});

/* Start of a later turn in the same session. */
const startedEvent = (turnId: string): HookEvent<"turn.started"> => ({
  data: { sequence: 6, turnId },
  meta,
  type: "turn.started",
});

/* Resolves pending input for the source turn, then starts the follow-up turn. */
const resolveThenStart = async (
  resolutions: Resolution[],
  kind = "channel:slack"
) => {
  await inputResolved(resolvedEvent(resolutions), hookContext(kind));
  await turnStarted(startedEvent("turn-2"), hookContext(kind));
};

/* A receipt whose flags differ from the defaults, so preservation is observable. */
const sourceReceipt = { failed: true, posted: true, turnId: "turn-1" };

beforeEach(() => {
  testState.reset();
  installTestState();
});

describe("Slack reply continuation", () => {
  it("transfers the receipt to the resumed turn after a session-limit continue", async () => {
    visualizationReceipts.update(() => sourceReceipt);
    await resolveThenStart([continueAnswer]);
    expect(visualizationReceipts.get()).toEqual({
      failed: true,
      posted: true,
      turnId: "turn-2",
    });
  });

  it("transfers ownership only once", async () => {
    visualizationReceipts.update(() => sourceReceipt);
    await resolveThenStart([continueAnswer]);
    // Reseed a turn-1 receipt: only clearing the pending resume prevents a second transfer.
    visualizationReceipts.update(() => sourceReceipt);
    await turnStarted(startedEvent("turn-3"), hookContext());
    expect(visualizationReceipts.get()).toEqual(sourceReceipt);
  });

  it.each<{ name: string; resolution: Resolution }>([
    {
      name: "a cancelled session-limit request",
      resolution: { ...continueAnswer, outcome: "cancelled" },
    },
    {
      name: "a different session-limit option",
      resolution: {
        ...continueAnswer,
        response: { optionId: "stop", requestId: "limit-1" },
      },
    },
    {
      name: "a continue answer to a question",
      resolution: { ...continueAnswer, kind: "question" },
    },
  ])("keeps the receipt with its turn after $name", async ({ resolution }) => {
    visualizationReceipts.update(() => sourceReceipt);
    await resolveThenStart([resolution]);
    expect(visualizationReceipts.get()).toEqual(sourceReceipt);
  });

  it("ignores continuations outside Slack", async () => {
    visualizationReceipts.update(() => sourceReceipt);
    await resolveThenStart([continueAnswer], "channel:http");
    expect(visualizationReceipts.get()).toEqual(sourceReceipt);
  });

  it("leaves a receipt owned by a different turn untouched", async () => {
    const otherReceipt = { failed: false, posted: true, turnId: "older-turn" };
    visualizationReceipts.update(() => otherReceipt);
    await resolveThenStart([continueAnswer]);
    expect(visualizationReceipts.get()).toEqual(otherReceipt);
  });

  it("does not retarget a receipt replaced before the resumed turn starts", async () => {
    visualizationReceipts.update(() => sourceReceipt);
    await inputResolved(resolvedEvent([continueAnswer]), hookContext());
    const otherReceipt = { failed: false, posted: true, turnId: "other-turn" };
    visualizationReceipts.update(() => otherReceipt);
    await turnStarted(startedEvent("turn-2"), hookContext());
    expect(visualizationReceipts.get()).toEqual(otherReceipt);
  });
});
