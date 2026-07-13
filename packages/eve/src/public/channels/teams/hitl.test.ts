import { describe, expect, it } from "vitest";

import {
  deriveTeamsInputResponses,
  isTeamsInputResponseActivity,
  parseTeamsHitlSubmission,
  renderInputRequestMessage,
  teamsInvokeResponse,
  TEAMS_HITL_CHOICE_INPUT_ID,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
} from "#public/channels/teams/hitl.js";
import { parseTeamsActivity } from "#public/channels/teams/inbound.js";
import type { InputRequest } from "#runtime/input/types.js";

const SECRET = "test-secret";

describe("Teams HITL helpers", () => {
  it("renders option buttons as Adaptive Card submit actions", () => {
    const body = renderInputRequestMessage(request(), renderOptions());
    const card = body.attachments?.[0]?.content as { actions?: unknown[] };
    expect(card.actions).toHaveLength(2);
    expect(card.actions?.[0]).toMatchObject({
      data: { [TEAMS_HITL_DATA_KEY]: { optionId: "approve", requestId: "REQ" } },
      type: "Action.Submit",
    });
  });

  it("renders approval tool input in the card and fallback text", () => {
    const body = renderInputRequestMessage(
      {
        ...request(),
        action: {
          callId: "TC",
          input: { campaign: "summer", dailyBudget: 500 },
          kind: "tool-call",
          toolName: "set_campaign_budget",
        },
        prompt: "Approve tool call: set_campaign_budget",
      },
      renderOptions(),
    );
    const card = body.attachments?.[0]?.content as {
      body?: Array<{ text?: string; type?: string }>;
    };

    expect(card.body?.[1]?.text).toContain('"campaign": "summer"');
    expect(card.body?.[1]?.text).toContain('"dailyBudget": 500');
    expect(body.text).toContain('"campaign": "summer"');
  });

  it("keeps the serialized Adaptive Card within the Teams byte budget", () => {
    const body = renderInputRequestMessage(
      {
        ...request(),
        action: {
          callId: "TC",
          input: { value: '\\"😀'.repeat(20_000) },
          kind: "tool-call",
          toolName: "large-write",
        },
        prompt: "Approve?".repeat(2_000),
      },
      renderOptions(),
    );
    const card = body.attachments?.[0]?.content;

    expect(new TextEncoder().encode(JSON.stringify(card)).byteLength).toBeLessThanOrEqual(
      28 * 1024,
    );
  });

  it("carries the signed route in every submit action", () => {
    const body = renderInputRequestMessage(request(), renderOptions());
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, unknown> }>;
    };

    expect(card.actions).toHaveLength(2);
    expect(card.actions?.[0]?.data).toMatchObject({
      [TEAMS_HITL_DATA_KEY]: { route: expect.any(Object) },
    });
    expect(card.actions?.[1]?.data).toMatchObject({
      [TEAMS_HITL_DATA_KEY]: { route: expect.any(Object) },
    });
  });

  it("renders select requests with a ChoiceSet", () => {
    const body = renderInputRequestMessage({ ...request(), display: "select" }, renderOptions());
    const card = body.attachments?.[0]?.content as { body?: Array<Record<string, unknown>> };
    expect(card.body?.some((entry) => entry.id === TEAMS_HITL_CHOICE_INPUT_ID)).toBe(true);
  });

  it("rejects select metadata that cannot fit within the card byte budget", () => {
    expect(() =>
      renderInputRequestMessage(
        {
          ...request(),
          display: "select",
          options: Array.from({ length: 100 }, (_, index) => ({
            id: `${index}-${"x".repeat(500)}`,
            label: `Option ${index}`,
          })),
        },
        renderOptions(),
      ),
    ).toThrow(/metadata exceeds/i);
  });

  it("rejects empty signing secrets", () => {
    expect(() => renderInputRequestMessage(request(), { ...renderOptions(), secret: " " })).toThrow(
      /must not be empty/i,
    );
  });

  it("derives the signature from the request being rendered", async () => {
    const otherRequest = { ...request(), requestId: "OTHER_REQUEST" };
    const body = renderInputRequestMessage(otherRequest, renderOptions());
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, unknown> }>;
    };
    const payload = card.actions?.[0]?.data?.[TEAMS_HITL_DATA_KEY];
    const activity = parseTeamsActivity({
      ...activityWithValue(undefined),
      channelData: { tenant: { id: "TENANT" } },
      conversation: { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" },
      name: "adaptiveCard/action",
      replyToId: "VOLATILE_ACTIVITY",
      type: "invoke",
      value: { action: { data: { [TEAMS_HITL_DATA_KEY]: payload } } },
    });

    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toMatchObject({
      kind: "valid",
      response: { requestId: "OTHER_REQUEST" },
    });
  });

  it("rejects tenantless message activity submit values", async () => {
    const activity = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          optionId: "deny",
          requestId: "REQ",
          route: renderedRoute(),
        },
      }),
    );
    expect(activity && isTeamsInputResponseActivity(activity)).toBe(true);
    expect(activity ? deriveTeamsInputResponses(activity) : []).toEqual([
      { optionId: "deny", requestId: "REQ" },
    ]);
    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("parses and verifies a message submission with tenant context", async () => {
    const activity = parseTeamsActivity({
      ...activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          optionId: "deny",
          requestId: "REQ",
          route: renderedRoute(),
        },
      }),
      channelData: { tenant: { id: "TENANT" } },
      conversation: { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" },
      replyToId: "THREAD_ROOT",
    });

    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toEqual({
      continuationToken: "TENANT:CONV:THREAD_ROOT",
      kind: "valid",
      response: { optionId: "deny", requestId: "REQ" },
    });
  });

  it("accepts personal-chat submissions even when Teams includes replyToId", async () => {
    const personalOptions = {
      ...renderOptions(),
      continuationToken: "TENANT:CONV:",
    };
    const body = renderInputRequestMessage(request(), personalOptions);
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, unknown> }>;
    };
    const payload = card.actions?.[0]?.data?.[TEAMS_HITL_DATA_KEY];
    const activity = parseTeamsActivity({
      ...activityWithValue(undefined),
      channelData: { tenant: { id: "TENANT" } },
      name: "adaptiveCard/action",
      replyToId: "CARD_ACTIVITY",
      type: "invoke",
      value: { action: { data: { [TEAMS_HITL_DATA_KEY]: payload } } },
    });

    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toMatchObject({ continuationToken: "TENANT:CONV:", kind: "valid" });
  });

  it("rejects a route copied into another thread", async () => {
    const activity = parseTeamsActivity({
      ...activityWithValue(undefined),
      channelData: { tenant: { id: "TENANT" } },
      conversation: { conversationType: "channel", id: "CONV;messageid=OTHER_THREAD" },
      name: "adaptiveCard/action",
      replyToId: "OTHER_THREAD",
      type: "invoke",
      value: {
        action: {
          data: {
            [TEAMS_HITL_DATA_KEY]: {
              optionId: "approve",
              requestId: "REQ",
              route: renderedRoute(),
            },
          },
        },
      },
    });

    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("rejects a route signed for another conversation", async () => {
    const activity = parseTeamsActivity({
      ...activityWithValue(undefined),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            [TEAMS_HITL_DATA_KEY]: {
              optionId: "approve",
              requestId: "REQ",
              route: renderedRoute({
                conversationId: "OTHER",
                continuationToken: "TENANT:OTHER:THREAD_ROOT",
              }),
            },
          },
        },
      },
    });

    await expect(
      activity && activity.type !== "conversationUpdate"
        ? parseTeamsHitlSubmission(activity, () => SECRET)
        : null,
    ).resolves.toEqual({ kind: "invalid" });
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

function renderOptions(
  input: {
    readonly continuationToken?: string;
    readonly conversationId?: string;
  } = {},
) {
  return {
    continuationToken: input.continuationToken ?? "TENANT:CONV:THREAD_ROOT",
    conversationId: input.conversationId ?? "CONV",
    secret: SECRET,
    tenantId: "TENANT",
  };
}

function renderedRoute(
  input: {
    readonly continuationToken?: string;
    readonly conversationId?: string;
  } = {},
) {
  const body = renderInputRequestMessage(request(), renderOptions(input));
  const card = body.attachments?.[0]?.content as {
    actions?: Array<{ data?: Record<string, unknown> }>;
  };
  const payload = card.actions?.[0]?.data?.[TEAMS_HITL_DATA_KEY];
  if (!payload || typeof payload !== "object" || !("route" in payload)) {
    throw new Error("Expected rendered Teams HITL route.");
  }
  return payload.route;
}

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
