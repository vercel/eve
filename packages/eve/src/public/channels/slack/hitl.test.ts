import { describe, expect, it } from "vitest";

import type { InputRequest } from "#runtime/input/types.js";
import {
  buildAnsweredBlocks,
  buildFreeformModalView,
  deriveHitlResponse,
  formatInputRequestFallbackText,
  freeformRequestIdFromActionId,
  HITL_ACTION_PREFIX,
  HITL_FREEFORM_ACTION_PREFIX,
  HITL_FREEFORM_MODAL_ACTION_ID,
  HITL_FREEFORM_MODAL_BLOCK_ID,
  HITL_FREEFORM_MODAL_CALLBACK_ID,
  isFreeformAction,
  isHitlAction,
  renderInputRequestBlocks,
} from "#public/channels/slack/hitl.js";
import {
  SLACK_CARD_BODY_TEXT_MAX_LENGTH,
  SLACK_SECTION_TEXT_MAX_LENGTH,
} from "#public/channels/slack/limits.js";

function makeRequest(overrides: Partial<InputRequest>): InputRequest {
  return {
    action: { kind: "tool-call", callId: "call_abc123", toolName: "ask_question", input: {} },
    prompt: "Pick one",
    requestId: "call_abc123",
    ...overrides,
  };
}

describe("deriveHitlResponse", () => {
  it("decodes a button click with a requestId that contains underscores", () => {
    // `requestId` is the AI SDK `action.callId`, which always starts
    // with `call_…` and contains underscores. The old encoding
    // split the action id on `_`, silently producing `requestId =
    // "call"`. The suffix-based encoding survives any requestId shape.
    const response = deriveHitlResponse({
      actionId: `${HITL_ACTION_PREFIX}call_abc123:button:0`,
      value: "approve",
    });

    expect(response).toEqual({ requestId: "call_abc123", optionId: "approve" });
  });

  it("decodes a radio / select click from selectedOptionValue", () => {
    const response = deriveHitlResponse({
      actionId: `${HITL_ACTION_PREFIX}call_xyz`,
      selectedOptionValue: "weekly",
    });

    expect(response).toEqual({ requestId: "call_xyz", optionId: "weekly" });
  });

  it("returns null when neither value nor selectedOptionValue is set", () => {
    expect(deriveHitlResponse({ actionId: `${HITL_ACTION_PREFIX}call_abc` })).toBeNull();
  });

  it("returns null for button clicks without the required Slack-unique suffix", () => {
    expect(
      deriveHitlResponse({ actionId: `${HITL_ACTION_PREFIX}call_abc`, value: "approve" }),
    ).toBeNull();
  });

  it("returns null when the action id does not match the HITL prefix", () => {
    expect(deriveHitlResponse({ actionId: "feedback_button_thumbs_up", value: "y" })).toBeNull();
  });

  it("returns null when the request id slice is empty", () => {
    expect(deriveHitlResponse({ actionId: HITL_ACTION_PREFIX, value: "approve" })).toBeNull();
  });
});

describe("isHitlAction", () => {
  it("matches the framework HITL prefix", () => {
    expect(isHitlAction(`${HITL_ACTION_PREFIX}r1`)).toBe(true);
  });

  it("does not match arbitrary action ids", () => {
    expect(isHitlAction("d0_sql_toggle_expand")).toBe(false);
    expect(isHitlAction("eve_input_legacy_call_abc_optA")).toBe(false);
  });
});

describe("renderInputRequestBlocks", () => {
  it("emits a card block for an option list with no display hint", () => {
    const blocks = renderInputRequestBlocks(
      makeRequest({
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
      }),
    );

    expect(blocks).toHaveLength(1);
    const card = blocks[0] as {
      body: { text: string; type: string; verbatim: boolean };
      actions: Array<Record<string, unknown>>;
      type: string;
    };
    expect(card).toMatchObject({
      type: "card",
      body: { type: "mrkdwn", text: "*Pick one*", verbatim: false },
    });
    expect(card.actions).toHaveLength(2);
    const actionIds = card.actions.map((element) => element.action_id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    expect(card.actions[0]).toMatchObject({
      type: "button",
      action_id: `${HITL_ACTION_PREFIX}call_abc123:button:0`,
      value: "approve",
      style: "primary",
      text: { type: "plain_text", text: "Approve", emoji: false },
    });
    expect(card.actions[1]).toMatchObject({
      type: "button",
      action_id: `${HITL_ACTION_PREFIX}call_abc123:button:1`,
      value: "deny",
      style: "danger",
      text: { type: "plain_text", text: "Deny", emoji: false },
    });
  });

  it("shows tool input for confirmation approval requests in a collapsible container", () => {
    const request = makeRequest({
      action: {
        kind: "tool-call",
        callId: "call_mongo",
        toolName: "mongodb-mutate",
        input: {
          operation: "deleteOne",
          collection: "org_members",
          filter: { _id: "qudw7ekkzulpgw3j" },
        },
      },
      display: "confirmation",
      prompt: "Approve tool call: mongodb-mutate",
      requestId: "approval_1",
      options: [
        { id: "approve", label: "Yes" },
        { id: "deny", label: "No" },
      ],
    });

    const blocks = renderInputRequestBlocks(request);

    expect(blocks).toHaveLength(2);
    const card = blocks[0] as {
      actions: Array<Record<string, unknown>>;
      body: { text: string; type: string };
      type: string;
    };
    expect(card).toMatchObject({
      type: "card",
      body: { type: "mrkdwn", text: "*Approve tool call: mongodb-mutate*" },
    });
    expect(card.actions).toMatchObject([
      { text: { text: "Deny" }, value: "deny" },
      { style: "primary", text: { text: "Allow" }, value: "approve" },
    ]);

    const details = blocks[1] as {
      child_blocks: Array<{ text?: { text?: string }; type: string }>;
      default_collapsed: boolean;
      is_collapsible: boolean;
      title: { text: string; type: string };
      type: string;
    };
    expect(details).toMatchObject({
      type: "container",
      title: { type: "plain_text", text: "Tool input" },
      is_collapsible: true,
      default_collapsed: false,
    });
    expect(details.child_blocks).toHaveLength(1);
    expect(details.child_blocks[0]).toMatchObject({ type: "section", text: { type: "mrkdwn" } });
    expect(details.child_blocks[0]?.text?.text).toContain('"collection": "org_members"');
    expect(details.child_blocks[0]?.text?.text).toContain('"_id": "qudw7ekkzulpgw3j"');
  });

  it("keeps long approval input details within the collapsible container section limit", () => {
    const blocks = renderInputRequestBlocks(
      makeRequest({
        action: {
          kind: "tool-call",
          callId: "call_long",
          toolName: "dangerous_tool",
          input: { value: "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500) },
        },
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
      }),
    );

    const card = blocks[0] as { body: { text: string } };
    expect(card.body.text.length).toBeLessThanOrEqual(SLACK_CARD_BODY_TEXT_MAX_LENGTH);
    expect(card.body.text).toBe("*Pick one*");

    const details = blocks[1] as { child_blocks: Array<{ text?: { text?: string } }> };
    const text = details.child_blocks[0]?.text?.text;
    expect(text?.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(text?.endsWith("...\n```")).toBe(true);
  });

  it("renders a radio_buttons widget for select-display requests with ≤6 options", () => {
    const blocks = renderInputRequestBlocks(
      makeRequest({
        display: "select",
        options: [
          { id: "daily", label: "Daily" },
          { id: "weekly", label: "Weekly", description: "Best for low-volume reports" },
        ],
      }),
    );

    const actions = blocks[1] as {
      elements: Array<Record<string, unknown>>;
    };
    expect(actions.elements).toHaveLength(1);
    const widget = actions.elements[0] as {
      type: string;
      action_id: string;
      options: Array<Record<string, unknown>>;
    };
    expect(widget.type).toBe("radio_buttons");
    expect(widget.action_id).toBe(`${HITL_ACTION_PREFIX}call_abc123`);
    expect(widget.options[0]).toEqual({
      text: { type: "plain_text", text: "Daily" },
      value: "daily",
    });
    expect(widget.options[1]).toEqual({
      text: { type: "plain_text", text: "Weekly" },
      value: "weekly",
      description: { type: "plain_text", text: "Best for low-volume reports" },
    });
  });

  it("falls back to a static_select dropdown when the option count exceeds the radio limit", () => {
    const options = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));

    const blocks = renderInputRequestBlocks(
      makeRequest({
        display: "select",
        options,
      }),
    );

    const actions = blocks[1] as {
      elements: Array<Record<string, unknown>>;
    };
    const widget = actions.elements[0] as {
      type: string;
      action_id: string;
      options: unknown[];
    };
    expect(widget.type).toBe("static_select");
    expect(widget.action_id).toBe(`${HITL_ACTION_PREFIX}call_abc123`);
    expect(widget.options).toHaveLength(8);
  });

  it("renders a 'Type your answer' freeform button when the request has no options", () => {
    const blocks = renderInputRequestBlocks(makeRequest({ prompt: "What's the date range?" }));

    expect(blocks).toHaveLength(2);
    const actions = blocks[1] as { type: string; elements: Array<Record<string, unknown>> };
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(1);
    const button = actions.elements[0] as {
      action_id: string;
      text: { text: string };
      style: string;
    };
    expect(button.action_id.startsWith(HITL_FREEFORM_ACTION_PREFIX)).toBe(true);
    expect(button.text.text).toBe("Type your answer");
    expect(button.style).toBe("primary");
  });

  it("uses option buttons when allowFreeform is set alongside options", () => {
    const blocks = renderInputRequestBlocks(
      makeRequest({
        allowFreeform: true,
        options: [{ id: "yes", label: "Yes" }],
      }),
    );
    // current behavior: options take precedence; freeform button is the
    // fallback when no options are supplied. This documents the
    // option-only path; freeform-with-options is left as future work.
    expect(blocks).toHaveLength(1);
    const card = blocks[0] as { actions: Array<{ action_id: string }> };
    const ids = card.actions.map((e) => e.action_id);
    for (const id of ids) {
      expect(id.startsWith(HITL_ACTION_PREFIX)).toBe(true);
    }
  });

  it("round-trips a button click without parsing collisions on underscore-bearing call ids", () => {
    const request = makeRequest({
      requestId: "call_with_many_underscores_99",
      options: [{ id: "yes_please", label: "Yes please" }],
    });

    const blocks = renderInputRequestBlocks(request);
    const button = (blocks[0] as { actions: Array<{ action_id: string; value: string }> })
      .actions[0]!;

    const response = deriveHitlResponse({ actionId: button.action_id, value: button.value });
    expect(response).toEqual({
      requestId: "call_with_many_underscores_99",
      optionId: "yes_please",
    });
  });

  it("isFreeformAction recognizes only the freeform prefix", () => {
    expect(isFreeformAction(`${HITL_FREEFORM_ACTION_PREFIX}call_abc`)).toBe(true);
    expect(isFreeformAction(`${HITL_ACTION_PREFIX}call_abc`)).toBe(false);
  });

  it("freeformRequestIdFromActionId extracts the trailing requestId slice", () => {
    expect(freeformRequestIdFromActionId(`${HITL_FREEFORM_ACTION_PREFIX}call_xyz`)).toBe(
      "call_xyz",
    );
    expect(freeformRequestIdFromActionId(`${HITL_ACTION_PREFIX}call_xyz`)).toBeUndefined();
    expect(freeformRequestIdFromActionId(HITL_FREEFORM_ACTION_PREFIX)).toBeUndefined();
  });

  it("truncates section-block prompts past the Slack 3000-char cap", () => {
    const longPrompt = "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500);
    const blocks = renderInputRequestBlocks(makeRequest({ prompt: longPrompt }));
    const promptBlock = blocks[0] as { text: { text: string } };
    expect(promptBlock.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(promptBlock.text.text.endsWith("...")).toBe(true);
  });

  it("round-trips a radio click without parsing collisions on underscore-bearing call ids", () => {
    const request = makeRequest({
      requestId: "call_with_many_underscores_99",
      display: "select",
      options: [{ id: "weekly_report", label: "Weekly report" }],
    });

    const blocks = renderInputRequestBlocks(request);
    const widget = (
      blocks[1] as { elements: Array<{ action_id: string; options: Array<{ value: string }> }> }
    ).elements[0]!;

    const response = deriveHitlResponse({
      actionId: widget.action_id,
      selectedOptionValue: widget.options[0]!.value,
    });
    expect(response).toEqual({
      requestId: "call_with_many_underscores_99",
      optionId: "weekly_report",
    });
  });
});

describe("formatInputRequestFallbackText", () => {
  it("includes approval tool input in Slack fallback text", () => {
    const text = formatInputRequestFallbackText(
      makeRequest({
        action: {
          kind: "tool-call",
          callId: "call_mongo",
          toolName: "mongodb-mutate",
          input: {
            operation: "deleteOne",
            collection: "orgs",
            filter: { _id: "48gtnni64rxqtaoh" },
          },
        },
        display: "confirmation",
        prompt: "Approve tool call: mongodb-mutate",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
      }),
    );

    expect(text).toContain("Approve tool call: mongodb-mutate");
    expect(text).toContain('"collection": "orgs"');
    expect(text).toContain('"_id": "48gtnni64rxqtaoh"');
  });

  it("leaves non-approval fallback text unchanged", () => {
    expect(formatInputRequestFallbackText(makeRequest({ prompt: "Pick one" }))).toBe("Pick one");
  });
});

describe("buildFreeformModalView", () => {
  it("emits a modal with the canonical callback_id and the prompt as a header block", () => {
    const view = buildFreeformModalView({
      metadata: {
        continuationToken: "slack:C01:1.0",
        channelId: "C01",
        threadTs: "1.0",
        messageTs: "1.1",
        requestId: "call_abc",
      },
      prompt: "What's the date range?",
    });

    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(HITL_FREEFORM_MODAL_CALLBACK_ID);
    expect(typeof view.private_metadata).toBe("string");
    const parsedMetadata = JSON.parse(view.private_metadata as string) as { requestId: string };
    expect(parsedMetadata.requestId).toBe("call_abc");

    const blocks = view.blocks as Array<Record<string, unknown>>;
    const inputBlock = blocks.find((b) => b.type === "input") as
      | { block_id?: string; element?: { action_id?: string } }
      | undefined;
    expect(inputBlock?.block_id).toBe(HITL_FREEFORM_MODAL_BLOCK_ID);
    expect(inputBlock?.element?.action_id).toBe(HITL_FREEFORM_MODAL_ACTION_ID);
  });

  it("truncates a long modal prompt to fit the section-text limit", () => {
    const longPrompt = "y".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 200);
    const view = buildFreeformModalView({
      metadata: {
        continuationToken: "slack:C01:1.0",
        channelId: "C01",
        threadTs: "1.0",
        messageTs: "1.1",
        requestId: "call_abc",
      },
      prompt: longPrompt,
    });
    const blocks = view.blocks as Array<{ type: string; text?: { text: string } }>;
    const section = blocks.find((b) => b.type === "section");
    expect(section?.text?.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(section?.text?.text.endsWith("...")).toBe(true);
  });

  it("omits the prompt section when no prompt is supplied", () => {
    const view = buildFreeformModalView({
      metadata: {
        continuationToken: "slack:C01:1.0",
        channelId: "C01",
        threadTs: "1.0",
        messageTs: "1.1",
        requestId: "call_abc",
      },
    });
    const blocks = view.blocks as Array<Record<string, unknown>>;
    expect(blocks.find((b) => b.type === "section")).toBeUndefined();
  });
});

describe("buildAnsweredBlocks", () => {
  it("preserves the prompt block, appends a confirmation, and attributes the click", () => {
    const promptBlock = {
      type: "section",
      text: { type: "mrkdwn", text: "Approve deploy?" },
    };
    const blocks = buildAnsweredBlocks({
      promptBlocks: [promptBlock],
      answerLabel: "Approve",
      userId: "U01",
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(promptBlock);
    expect(blocks[1]).toMatchObject({
      type: "section",
      text: { text: ":white_check_mark: *Approve*", type: "mrkdwn" },
    });
    expect(blocks[2]).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Answered by <@U01>" }],
    });
  });

  it("preserves multiple prompt/detail blocks", () => {
    const promptBlock = {
      type: "section",
      text: { type: "mrkdwn", text: "Approve tool call: mongodb-mutate" },
    };
    const detailBlock = {
      type: "section",
      text: { type: "mrkdwn", text: '*Tool input*\n```\n{ "_id": "org_1" }\n```' },
    };

    const blocks = buildAnsweredBlocks({
      promptBlocks: [promptBlock, detailBlock],
      answerLabel: "Yes",
      userId: "U01",
    });

    expect(blocks[0]).toBe(promptBlock);
    expect(blocks[1]).toBe(detailBlock);
    expect(blocks[2]).toMatchObject({
      type: "section",
      text: { text: ":white_check_mark: *Yes*" },
    });
  });

  it("omits the attribution block when no userId is supplied", () => {
    const blocks = buildAnsweredBlocks({ promptBlocks: [], answerLabel: "Deny" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: { text: ":white_check_mark: *Deny*" },
    });
  });

  it("caps long freeform answer labels at the section limit", () => {
    const blocks = buildAnsweredBlocks({
      promptBlocks: [],
      answerLabel: "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500),
    });

    const answer = blocks[0] as { text: { text: string } };
    expect(answer.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(answer.text.text).toMatch(/^:white_check_mark: \*x+\.\.\.\*$/u);
  });
});
