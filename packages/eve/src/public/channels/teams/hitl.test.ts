import { describe, expect, it } from "vitest";

import {
  deriveTeamsInputResponses,
  isTeamsInputResponseActivity,
  renderInputRequestMessage,
  teamsInvokeResponse,
  TEAMS_HITL_CHOICE_INPUT_ID,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
} from "#public/channels/teams/hitl.js";
import { parseTeamsActivity } from "#public/channels/teams/inbound.js";
import type { InputRequest } from "#runtime/input/types.js";

describe("Teams HITL helpers", () => {
  it("renders option buttons as Adaptive Card submit actions", () => {
    const body = renderInputRequestMessage(request());
    const card = body.attachments?.[0]?.content as { actions?: unknown[] };
    expect(card.actions).toHaveLength(2);
    expect(card.actions?.[0]).toMatchObject({
      data: { [TEAMS_HITL_DATA_KEY]: { optionId: "approve", requestId: "REQ" } },
      type: "Action.Submit",
    });
  });

  it("renders select requests with a ChoiceSet", () => {
    const body = renderInputRequestMessage({ ...request(), display: "select" });
    const card = body.attachments?.[0]?.content as { body?: Array<Record<string, unknown>> };
    expect(card.body?.some((entry) => entry.id === TEAMS_HITL_CHOICE_INPUT_ID)).toBe(true);
  });

  it("decodes message activity submit values", () => {
    const activity = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: { requestId: "REQ", optionId: "deny" },
      }),
    );
    expect(activity && isTeamsInputResponseActivity(activity)).toBe(true);
    expect(activity ? deriveTeamsInputResponses(activity) : []).toEqual([
      { optionId: "deny", requestId: "REQ" },
    ]);
  });

  it("decodes adaptiveCard/action invoke values with freeform text", () => {
    const activity = parseTeamsActivity({
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
    expect(activity ? deriveTeamsInputResponses(activity) : []).toEqual([
      { requestId: "REQ", text: "freeform" },
    ]);
  });

  it("builds Teams invoke responses", () => {
    expect(teamsInvokeResponse({ message: "ok" })).toEqual({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: "ok",
    });
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
