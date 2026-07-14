import { describe, expect, it } from "vitest";

import {
  deriveTeamsInputResponses,
  readTeamsInputReplyToActivityId,
  renderInputRequestMessage,
  TEAMS_HITL_CHOICE_INPUT_ID,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
} from "#public/channels/teams/hitl.js";
import { parseTeamsActivity } from "#public/channels/teams/inbound.js";
import type { InputRequest } from "#runtime/input/types.js";

describe("Teams HITL helpers", () => {
  it("renders approval tool input in the card and fallback text", () => {
    const body = renderInputRequestMessage({
      ...request(),
      action: {
        callId: "TC",
        input: { campaign: "summer", dailyBudget: 500 },
        kind: "tool-call",
        toolName: "set_campaign_budget",
      },
    });
    const card = body.attachments?.[0]?.content as {
      body?: Array<{ text?: string }>;
    };

    expect(card.body?.[1]?.text).toContain('"campaign": "summer"');
    expect(body.text).toContain('"dailyBudget": 500');
  });

  it("carries the continuation token in submit actions", () => {
    const body = renderInputRequestMessage(request(), { replyToActivityId: "ROOT" });
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, unknown> }>;
    };

    expect(card.actions?.[0]?.data).toMatchObject({
      [TEAMS_HITL_DATA_KEY]: { replyToActivityId: "ROOT" },
    });
  });

  it("renders select requests with a ChoiceSet", () => {
    const body = renderInputRequestMessage({ ...request(), display: "select" });
    const card = body.attachments?.[0]?.content as { body?: Array<Record<string, unknown>> };
    expect(card.body?.some((entry) => entry.id === TEAMS_HITL_CHOICE_INPUT_ID)).toBe(true);
  });

  it("decodes message and invoke submission values", () => {
    const message = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          replyToActivityId: "ROOT",
          optionId: "deny",
          requestId: "REQ",
        },
      }),
    );
    expect(message ? deriveTeamsInputResponses(message) : []).toEqual([
      { optionId: "deny", requestId: "REQ" },
    ]);
    expect(message ? readTeamsInputReplyToActivityId(message) : null).toBe("ROOT");

    const invoke = parseTeamsActivity({
      ...activityWithValue(undefined),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            [TEAMS_HITL_DATA_KEY]: { requestId: "REQ" },
            [TEAMS_HITL_FREEFORM_INPUT_ID]: "freeform",
          },
        },
      },
    });
    expect(invoke ? deriveTeamsInputResponses(invoke) : []).toEqual([
      { requestId: "REQ", text: "freeform" },
    ]);
  });
});

function request(): InputRequest {
  return {
    action: { callId: "TC", input: {}, kind: "tool-call", toolName: "deploy" },
    display: "confirmation",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    prompt: "Approve deploy?",
    requestId: "REQ",
  };
}

function activityWithValue(value: unknown): Record<string, unknown> {
  return {
    conversation: { conversationType: "personal", id: "CONV" },
    from: { id: "USER" },
    id: "ACTIVITY_1",
    recipient: { id: "BOT" },
    serviceUrl: "https://smba.example.test/teams",
    text: "",
    type: "message",
    value,
  };
}
