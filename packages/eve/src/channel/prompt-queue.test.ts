import { describe, expect, it } from "vitest";

import { snapshotOf } from "#protocol/session-projection/session-view.js";
import { firstOpenRequest } from "#channel/interaction-prompts.js";
import { promptQueue } from "#channel/prompt-queue.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import type { Interaction } from "#protocol/session-projection/reader.js";

const at = "2026-10-09T00:00:00.000Z";
const turnId = "turn_0";
const runId = "run_0";
const scope = { runId, turnId };

/** A paused turn asking two approvals in one batch, and then `answers`' lines. */
function viewWith(answers: readonly StoredLine[] = []) {
  const call = (callId: string) => ({
    data: { callId, capability: { kind: "tool", name: callId }, owner: { runId } },
    scope,
    type: "call.requested",
  });
  const approval = (interactionId: string, callId: string) => ({
    data: {
      interactionId,
      request: { kind: "approval", prompt: `Approve ${callId}?` },
      subject: { callId },
    },
    scope: { turnId },
    type: "interaction.opened",
  });
  const lines: StoredLine[] = [
    {
      at,
      facts: [
        { data: {}, type: "session.started" },
        { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
      ],
    },
    {
      at,
      facts: [
        {
          data: { cause: { deliveryId: "d_0" }, follows: null, turnId },
          scope: { turnId },
          type: "turn.started",
        },
        { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
        call("a"),
        call("b"),
        { data: { outcome: "completed", runId }, scope, type: "model.settled" },
        approval("approval-a", "a"),
        approval("approval-b", "b"),
      ],
    },
    ...answers,
  ];
  const view = emptySessionView();
  foldLines(view, lines, 0);
  return view;
}

const answerA: StoredLine[] = [
  {
    at,
    facts: [
      { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
      {
        data: {
          deliveryId: "d_1",
          interactionId: "approval-a",
          responseId: "r_a",
          value: { optionId: "approve" },
        },
        type: "response.submitted",
      },
      { data: { responseId: "r_a" }, type: "response.admitted" },
    ],
  },
];

describe("showing one request at a time", () => {
  it("shows the first open request, then the next once its answer waits for the batch", () => {
    expect(firstOpenRequest(viewWith())?.interactionId).toBe("approval-a");
    expect(firstOpenRequest(viewWith(answerA))?.interactionId).toBe("approval-b");
  });

  it("moves a channel's shown request on when an answer is admitted, once per change", async () => {
    const shown: string[] = [];
    const committed = promptQueue(async (_channel: unknown, request: Interaction) => {
      shown.push(request.interactionId);
    });
    const channel = { state: {} };
    await committed(undefined, { channel, view: snapshotOf(viewWith()) });
    await committed(undefined, { channel, view: snapshotOf(viewWith()) });
    await committed(undefined, { channel, view: snapshotOf(viewWith(answerA)) });

    expect(shown).toEqual(["approval-a", "approval-b"]);
  });

  it("tries a request it failed to show again at the next commit", async () => {
    let fails = true;
    const shown: string[] = [];
    const committed = promptQueue(async (_channel: unknown, request: Interaction) => {
      if (fails) return false;
      shown.push(request.interactionId);
    });
    const channel = { state: {} };
    await committed(undefined, { channel, view: snapshotOf(viewWith()) });
    fails = false;
    await committed(undefined, { channel, view: snapshotOf(viewWith()) });

    expect(shown).toEqual(["approval-a"]);
  });
});
