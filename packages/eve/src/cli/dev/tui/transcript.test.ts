import { describe, expect, it } from "vitest";

import { Conversation } from "#client/conversation.js";
import type { EveAgentStoreSnapshot } from "#client/eve-agent-store-state.js";
import { stampTestEvent, testTurnFacts } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

import { conversationView, tuiSessionData } from "./conversation-view.js";
import { ConversationTranscript } from "./transcript.js";

const OPTIONS = {
  connectionAuth: "full",
  reasoning: "full",
  subagents: "full",
  tools: "full",
} as const;

function project(events: readonly SessionEvent[]) {
  const conversation = new Conversation();
  events.forEach((event, index) => conversation.observe(stampTestEvent(event, index)));
  const snapshot: EveAgentStoreSnapshot = {
    ...conversation.state,
    view: conversation.view,
    error: undefined,
    events: [],
    session: undefined,
    status: "idle",
  };
  const view = conversationView(snapshot, tuiSessionData(conversation.state));
  return new ConversationTranscript()
    .project(view, OPTIONS)
    .map((block) =>
      block.kind === "tool"
        ? `tool: ${block.title} ${block.status}`
        : `${block.kind}: ${block.body ?? ""}`,
    );
}

describe("ConversationTranscript", () => {
  it("shows one cancellation after the last piece of a turn split by a follow-up", () => {
    const scope = { turnId: "turn_0", runId: "run_followup" };
    const blocks = project([
      ...testTurnFacts(0, "One.", ["d_0"]).slice(0, 6),
      { type: "delivery.admitted", data: { deliveryId: "followup" } },
      {
        type: "delivery.consumed",
        data: {
          deliveryId: "followup",
          turnId: "turn_0",
          parts: [{ kind: "text", text: "continue" }],
        },
      },
      {
        type: "model.requested",
        scope,
        data: { runId: "run_followup", owner: { turnId: "turn_0" } },
      },
      {
        type: "content.completed",
        scope,
        data: {
          partId: "followup_part",
          kind: "text",
          phase: "reply",
          runId: "run_followup",
          value: "Two.",
        },
      },
      { type: "model.settled", scope, data: { runId: "run_followup", outcome: "completed" } },
      { type: "turn.settled", data: { turnId: "turn_0", outcome: "cancelled" } },
    ]);
    expect(blocks).toEqual([
      "user: one.",
      "assistant: One.",
      "user: continue",
      "assistant: Two.",
      "notice: Cancelled.",
    ]);
  });

  it("shows a failed turn's error where the turn ended, before the next turn", () => {
    const failed = testTurnFacts(0, "One.", ["d_0"]).map((event) =>
      event.type === "turn.settled"
        ? ({
            ...event,
            data: {
              error: { code: "MODEL_FAILED", message: "The model failed." },
              outcome: "failed",
              turnId: "turn_0",
            },
          } as SessionEvent)
        : event,
    );
    const blocks = project([
      { data: {}, type: "session.started" },
      ...failed,
      ...testTurnFacts(1, "Two.", ["d_1"]),
    ]);

    expect(blocks.filter((block) => !block.startsWith("notice"))).toEqual([
      "user: one.",
      "assistant: One.",
      "error: MODEL_FAILED: The model failed.",
      "user: two.",
      "assistant: Two.",
    ]);
  });

  it("shows a failed session's error in place of the turn it cancelled", () => {
    const cancelled = testTurnFacts(0, "One.", ["d_0"]).map((event) =>
      event.type === "turn.settled"
        ? ({ ...event, data: { outcome: "cancelled", turnId: "turn_0" } } as SessionEvent)
        : event,
    );
    const blocks = project([
      { data: {}, type: "session.started" },
      ...cancelled,
      {
        data: {
          cause: { turnId: "turn_0" },
          error: { code: "MODEL_FAILED", message: "The model failed." },
          outcome: "failed",
        },
        type: "session.ended",
      },
    ]);

    expect(blocks).toEqual([
      "user: one.",
      "assistant: One.",
      "error: MODEL_FAILED: The model failed.",
    ]);
  });

  it("shows a turn's narration, each call's outcome, and its reply in stream order", () => {
    const turn = { turnId: "turn_0" };
    const run = (runId: string) => ({ runId, turnId: "turn_0" });
    const blocks = project([
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
      {
        data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
        scope: turn,
        type: "turn.started",
      },
      {
        data: {
          deliveryId: "d_0",
          parts: [{ kind: "text", text: "Deploy it." }],
          turnId: "turn_0",
        },
        scope: turn,
        type: "delivery.consumed",
      },
      { data: { owner: turn, runId: "run_0" }, scope: run("run_0"), type: "model.requested" },
      {
        data: {
          kind: "text",
          partId: "p_0",
          phase: "narration",
          runId: "run_0",
          value: "Checking first.",
        },
        scope: run("run_0"),
        type: "content.completed",
      },
      {
        data: {
          callId: "call_check",
          capability: { kind: "tool", name: "check" },
          input: {},
          owner: { runId: "run_0" },
        },
        scope: run("run_0"),
        type: "call.requested",
      },
      {
        data: {
          callId: "call_deploy",
          capability: { kind: "tool", name: "deploy" },
          input: {},
          owner: { runId: "run_0" },
        },
        scope: run("run_0"),
        type: "call.requested",
      },
      {
        data: { callId: "call_check", outcome: "completed", output: "ok" },
        scope: run("run_0"),
        type: "call.settled",
      },
      {
        data: {
          interactionId: "i_0",
          request: {
            kind: "approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "deny", label: "Deny" },
            ],
            prompt: "Deploy?",
          },
          subject: { callId: "call_deploy" },
        },
        scope: turn,
        type: "interaction.opened",
      },
      {
        data: { outcome: "completed", runId: "run_0" },
        scope: run("run_0"),
        type: "model.settled",
      },
      {
        data: { cause: { responseId: "r_0" }, interactionId: "i_0", outcome: "declined" },
        scope: turn,
        type: "interaction.settled",
      },
      {
        data: { callId: "call_deploy", cause: { interactionId: "i_0" }, outcome: "rejected" },
        scope: run("run_0"),
        type: "call.settled",
      },
      { data: { owner: turn, runId: "run_1" }, scope: run("run_1"), type: "model.requested" },
      {
        data: {
          kind: "text",
          partId: "p_1",
          phase: "reply",
          runId: "run_1",
          value: "Not deployed.",
        },
        scope: run("run_1"),
        type: "content.completed",
      },
      {
        data: { outcome: "completed", runId: "run_1" },
        scope: run("run_1"),
        type: "model.settled",
      },
      {
        data: { outcome: "completed", reply: ["p_1"], turnId: "turn_0" },
        scope: turn,
        type: "turn.settled",
      },
    ] as SessionEvent[]);

    expect(blocks).toEqual([
      "user: Deploy it.",
      "assistant: Checking first.",
      "tool: Check done",
      // A call its approver declined reads as denied, not failed.
      "tool: Deploy denied",
      "assistant: Not deployed.",
    ]);
  });
});
