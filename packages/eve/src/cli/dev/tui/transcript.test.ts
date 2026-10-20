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
    .map((block) => `${block.kind}: ${block.body ?? ""}`);
}

describe("ConversationTranscript", () => {
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
});
