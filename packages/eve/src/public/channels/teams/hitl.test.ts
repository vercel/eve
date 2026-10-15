import { describe, expect, it } from "vitest";

import {
  deriveTeamsInputResponses,
  isTeamsToolApprovalResponseActivity,
  readTeamsInputReplyToActivityId,
  renderInputRequestMessage,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
  TEAMS_HITL_PROMPT_KEY,
  TEAMS_HITL_REQUEST_KIND_KEY,
} from "#public/channels/teams/hitl.js";
import { parseTeamsActivity } from "#public/channels/teams/inbound.js";
import type { InputRequest } from "#shared/input.js";

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
      [TEAMS_HITL_DATA_KEY]: {
        [TEAMS_HITL_PROMPT_KEY]: "Approve deploy?",
        [TEAMS_HITL_REQUEST_KIND_KEY]: "tool-approval",
        replyToActivityId: "ROOT",
      },
    });
  });

  it("carries the prompt each button submits as the card shows it", () => {
    const prompt = "x".repeat(20_000);
    const body = renderInputRequestMessage({
      ...request(),
      kind: "question",
      options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id })),
      prompt,
      requestId: "REQ",
    });
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, Record<string, unknown>> }>;
      body?: Array<{ text?: string }>;
    };
    const shown = card.body?.[0]?.text;

    expect(shown?.length).toBeLessThan(prompt.length);
    expect(card.actions).toHaveLength(6);
    for (const action of card.actions ?? []) {
      expect(action.data?.[TEAMS_HITL_DATA_KEY]?.[TEAMS_HITL_PROMPT_KEY]).toBe(shown);
    }
  });

  it("decodes message and invoke submission values", () => {
    const message = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          replyToActivityId: "ROOT",
          optionId: "cancel",
          requestId: "REQ",
        },
      }),
    );
    expect(message ? deriveTeamsInputResponses(message) : []).toEqual([
      { optionId: "cancel", requestId: "REQ" },
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
    expect(invoke ? isTeamsToolApprovalResponseActivity(invoke) : false).toBe(false);
  });

  it("identifies tool approval submissions", () => {
    const activity = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          [TEAMS_HITL_REQUEST_KIND_KEY]: "tool-approval",
          optionId: "approve",
          requestId: "REQ",
        },
      }),
    );

    expect(activity ? isTeamsToolApprovalResponseActivity(activity) : false).toBe(true);
  });
});

function request(): InputRequest {
  return {
    action: { callId: "TC", input: {}, kind: "tool-call", toolName: "deploy" },
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "cancel", label: "Cancel", style: "danger" },
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
