import { describe, expect, it } from "vitest";

import {
  deriveTeamsAnswers,
  isTeamsToolApprovalResponseActivity,
  readTeamsInputReplyToActivityId,
  renderInteractionMessage,
  TEAMS_HITL_DATA_KEY,
  TEAMS_HITL_FREEFORM_INPUT_ID,
  TEAMS_HITL_PROMPT_KEY,
  TEAMS_HITL_REQUEST_KIND_KEY,
} from "#public/channels/teams/hitl.js";
import { parseTeamsActivity } from "#public/channels/teams/inbound.js";
import type { Interaction } from "#protocol/session-projection/reader.js";

describe("Teams HITL helpers", () => {
  it("renders approval tool input in the card and fallback text", () => {
    const body = renderInteractionMessage({
      ...request(),
      call: {
        callId: "TC",
        input: { campaign: "summer", dailyBudget: 500 },
        name: "set_campaign_budget",
      },
    });
    const card = body.attachments?.[0]?.content as { body?: CardBlock[] };

    expect(literalText(card.body?.[1])).toContain('"campaign": "summer"');
    expect(body.text).toContain('"dailyBudget": 500');
  });

  it("renders a model-written prompt and tool input as literal text, not markdown", () => {
    const link = "[docs](https://evil.example)";
    const body = renderInteractionMessage({
      ...request(),
      call: { callId: "TC", input: { url: link }, name: "fetch_page" },
      request: { ...request().request, prompt: `Open ${link}?` },
    });
    const card = body.attachments?.[0]?.content as { body?: CardBlock[] };

    expect(card.body?.slice(0, 2)).toEqual([
      { inlines: [{ text: `Open ${link}?`, type: "TextRun" }], type: "RichTextBlock" },
      {
        inlines: [{ fontType: "Monospace", text: expect.stringContaining(link), type: "TextRun" }],
        type: "RichTextBlock",
      },
    ]);
    expect(body.textFormat).toBe("plain");
  });

  it("carries the continuation token in submit actions", () => {
    const body = renderInteractionMessage(request(), { replyToActivityId: "ROOT" });
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
    const body = renderInteractionMessage({
      ...request(),
      request: {
        kind: "question",
        options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id })),
        prompt,
      },
    });
    const card = body.attachments?.[0]?.content as {
      actions?: Array<{ data?: Record<string, Record<string, unknown>> }>;
      body?: CardBlock[];
    };
    const shown = literalText(card.body?.[0]);

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
    expect(message ? deriveTeamsAnswers(message) : []).toEqual([
      { optionId: "cancel", interactionId: "REQ" },
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
    expect(invoke ? deriveTeamsAnswers(invoke) : []).toEqual([
      { interactionId: "REQ", text: "freeform" },
    ]);
    expect(invoke ? isTeamsToolApprovalResponseActivity(invoke) : false).toBe(false);
  });

  it("identifies tool approval submissions", () => {
    const activity = parseTeamsActivity(
      activityWithValue({
        [TEAMS_HITL_DATA_KEY]: {
          [TEAMS_HITL_REQUEST_KIND_KEY]: "tool-approval",
          optionId: "approve",
          interactionId: "REQ",
        },
      }),
    );

    expect(activity ? isTeamsToolApprovalResponseActivity(activity) : false).toBe(true);
  });
});

function request(): Interaction {
  return {
    call: { callId: "TC", input: {}, name: "deploy" },
    interactionId: "REQ",
    status: "open",
    turnId: "turn_0",
    stepIndex: 0,
    request: {
      display: "confirmation",
      kind: "approval",
      prompt: "Approve deploy?",
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "cancel", label: "Cancel", style: "danger" },
      ],
    },
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

interface CardBlock {
  readonly inlines?: readonly { readonly text?: string }[];
}

function literalText(block: CardBlock | undefined): string | undefined {
  return block?.inlines?.[0]?.text;
}
