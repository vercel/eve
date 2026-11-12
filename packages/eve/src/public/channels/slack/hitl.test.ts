import { describe, expect, it } from "vitest";

import type { Interaction } from "#protocol/session-projection/reader.js";
import {
  answerLabelOf,
  buildAnsweredBlocks,
  buildFreeformModalView,
  decodeFreeformHitlActionId,
  decodeHitlActionId,
  HITL_FREEFORM_ACTION_PREFIX,
  HITL_FREEFORM_MODAL_ACTION_ID,
  HITL_FREEFORM_MODAL_BLOCK_ID,
  HITL_FREEFORM_MODAL_CALLBACK_ID,
  isFreeformAction,
  isHitlAction,
  renderInteractionPostParts,
} from "#public/channels/slack/hitl.js";
import {
  answerFromSlackAction,
  ANSWER_ACTION_PREFIX,
  renderInteractionBlocks,
} from "#public/channels/slack/index.js";
import { SLACK_SECTION_TEXT_MAX_LENGTH } from "#public/channels/slack/limits.js";

function makeRequest(
  overrides: Partial<Interaction["request"]> &
    Partial<Pick<Interaction, "interactionId" | "call">> = {},
): Interaction {
  const {
    interactionId = "call_abc123",
    call = { callId: "call_abc123", name: "ask_question", input: {} },
    ...request
  } = overrides;
  return {
    interactionId,
    call,
    status: "open",
    turnId: "turn_0",
    stepIndex: 0,
    request: { prompt: "Pick one", kind: "question", ...request },
  };
}

describe("private HITL routes", () => {
  it("renders and decodes one typed return route", () => {
    const blocks = renderInteractionBlocks(
      makeRequest({
        kind: "approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        interactionId: "approval_abc123",
      }),
      { channelId: "C123", threadTs: "111.222" },
    );
    const actionId = (blocks[0] as { actions: Array<{ action_id: string }> }).actions[0]!.action_id;

    expect(decodeHitlActionId(actionId)).toEqual({
      button: true,
      kind: "tool-approval",
      requestId: "approval_abc123",
      route: { channelId: "C123", threadTs: "111.222" },
    });
    expect(answerFromSlackAction({ actionId, value: "approve" })).toMatchObject({
      kind: "tool-approval",
      response: { optionId: "approve", interactionId: "approval_abc123" },
      route: { channelId: "C123", threadTs: "111.222" },
    });
  });

  // A code channel's session has no thread, so its route says so instead of leaving it empty.
  it("round-trips a code channel route and rejects an empty thread", () => {
    const route = { channelId: "C123", codeChannel: true } as const;
    const blocks = renderInteractionBlocks(
      makeRequest({ options: [{ id: "yes", label: "Yes" }], interactionId: "q_1" }),
      route,
    );
    const actionId = (blocks[0] as { actions: Array<{ action_id: string }> }).actions[0]!.action_id;

    expect(decodeHitlActionId(actionId)?.route).toEqual(route);
    expect(decodeHitlActionId(actionId.replace("code:C123:", "route:C123::"))).toBeNull();
  });
});

describe("answerFromSlackAction", () => {
  it("keeps Slack classification outside the durable input response type", () => {
    const derived: NonNullable<ReturnType<typeof answerFromSlackAction>> = {
      kind: "tool-approval",
      response: {
        // @ts-expect-error Slack classification is not part of Answer.
        kind: "tool-approval",
        optionId: "approve",
        interactionId: "approval_abc123",
      },
    };

    expect(derived.kind).toBe("tool-approval");
  });

  it("decodes a button click with a requestId that contains underscores", () => {
    // `requestId` is the AI SDK `action.callId`, which always starts
    // with `call_…` and contains underscores. The old encoding
    // split the action id on `_`, silently producing `requestId =
    // "call"`. The suffix-based encoding survives any requestId shape.
    const response = answerFromSlackAction({
      actionId: `${ANSWER_ACTION_PREFIX}call_abc123:button:0`,
      value: "approve",
    });

    expect(response).toEqual({
      response: { interactionId: "call_abc123", optionId: "approve" },
    });
  });

  it("decodes a radio / select click from selectedOptionValue", () => {
    const response = answerFromSlackAction({
      actionId: `${ANSWER_ACTION_PREFIX}call_xyz`,
      selectedOptionValue: "weekly",
    });

    expect(response).toEqual({ response: { interactionId: "call_xyz", optionId: "weekly" } });
  });

  it("preserves tool-approval metadata from a button action id", () => {
    const response = answerFromSlackAction({
      actionId: `${ANSWER_ACTION_PREFIX}tool-approval:approval_abc123:button:0`,
      value: "approve",
    });

    expect(response).toEqual({
      kind: "tool-approval",
      response: {
        optionId: "approve",
        interactionId: "approval_abc123",
      },
    });
  });

  it("returns null when neither value nor selectedOptionValue is set", () => {
    expect(answerFromSlackAction({ actionId: `${ANSWER_ACTION_PREFIX}call_abc` })).toBeNull();
  });

  it("returns null for button clicks without the required Slack-unique suffix", () => {
    expect(
      answerFromSlackAction({ actionId: `${ANSWER_ACTION_PREFIX}call_abc`, value: "approve" }),
    ).toBeNull();
  });

  it("returns null when the action id does not match the HITL prefix", () => {
    expect(answerFromSlackAction({ actionId: "feedback_button_thumbs_up", value: "y" })).toBeNull();
  });

  it("returns null when the request id slice is empty", () => {
    expect(answerFromSlackAction({ actionId: ANSWER_ACTION_PREFIX, value: "approve" })).toBeNull();
  });
});

describe("isHitlAction", () => {
  it("matches the framework HITL prefix", () => {
    expect(isHitlAction(`${ANSWER_ACTION_PREFIX}r1`)).toBe(true);
  });

  it("does not match arbitrary action ids", () => {
    expect(isHitlAction("d0_sql_toggle_expand")).toBe(false);
    expect(isHitlAction("eve_input_legacy_call_abc_optA")).toBe(false);
  });
});

describe("renderInteractionBlocks", () => {
  it("emits a card block for an option list with no display hint", () => {
    const blocks = renderInteractionBlocks(
      makeRequest({
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "cancel", label: "Cancel", style: "danger" },
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
      action_id: `${ANSWER_ACTION_PREFIX}call_abc123:button:0`,
      value: "approve",
      style: "primary",
      text: { type: "plain_text", text: "Approve", emoji: false },
    });
    expect(card.actions[1]).toMatchObject({
      type: "button",
      action_id: `${ANSWER_ACTION_PREFIX}call_abc123:button:1`,
      value: "cancel",
      style: "danger",
      text: { type: "plain_text", text: "Cancel", emoji: false },
    });
  });

  it("renders an approval with tool input as one container: prompt, input, then buttons", () => {
    const request = makeRequest({
      call: {
        callId: "call_mongo",
        name: "mongodb-mutate",
        input: {
          operation: "deleteOne",
          collection: "org_members",
          filter: { _id: "qudw7ekkzulpgw3j" },
        },
      },
      display: "confirmation",
      kind: "approval",
      prompt: "Approve tool call: mongodb-mutate",
      interactionId: "approval_1",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    });

    const blocks = renderInteractionBlocks(request);

    expect(blocks).toEqual([
      {
        type: "container",
        title: { type: "plain_text", text: "Approve tool call: mongodb-mutate" },
        subtitle: { type: "mrkdwn", text: "I've paused until someone approves or denies." },
        has_header_divider: true,
        child_blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "operation", style: { bold: true } },
                  { type: "text", text: "  " },
                  { type: "text", text: "deleteOne" },
                  { type: "text", text: "\n" },
                  { type: "text", text: "collection", style: { bold: true } },
                  { type: "text", text: "  " },
                  { type: "text", text: "org_members" },
                  { type: "text", text: "\n" },
                  { type: "text", text: "filter", style: { bold: true } },
                  { type: "text", text: "  " },
                  { type: "text", text: '{"_id":"qudw7ekkzulpgw3j"}', style: { code: true } },
                ],
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: `${ANSWER_ACTION_PREFIX}tool-approval:approval_1:button:1`,
                style: "primary",
                text: { type: "plain_text", text: "Approve", emoji: false },
                value: "approve",
              },
              {
                type: "button",
                action_id: `${ANSWER_ACTION_PREFIX}tool-approval:approval_1:button:0`,
                text: { type: "plain_text", text: "Deny", emoji: false },
                value: "deny",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("titles an approval with a blank prompt by its tool name, since Slack refuses an empty title", () => {
    const [container] = renderInteractionBlocks(
      makeRequest({
        call: { callId: "call_deploy", name: "deploy", input: { env: "prod" } },
        display: "confirmation",
        kind: "approval",
        prompt: " \n ",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      }),
    );

    expect(container).toMatchObject({ title: { type: "plain_text", text: "deploy" } });
  });

  it("keeps an approval without tool input as a compact card", () => {
    const [card, ...rest] = renderInteractionBlocks(
      makeRequest({
        call: { callId: "call_ping", name: "ping", input: {} },
        display: "confirmation",
        kind: "approval",
        prompt: "Ping the service?",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      }),
    );

    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      type: "card",
      body: { type: "mrkdwn", text: "*Ping the service?*" },
      subtext: { type: "mrkdwn", text: "I've paused until someone approves or denies." },
    });
  });

  it("bounds the input preview however large the tool input is", () => {
    const preview = (input: Record<string, string>) => {
      const [container] = renderInteractionBlocks(
        makeRequest({
          call: { callId: "call_long", name: "dangerous_tool", input },
          display: "confirmation",
          kind: "approval",
          prompt: "x".repeat(400),
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
        }),
      ) as [{ child_blocks: unknown[]; title: { text: string } }];
      return container;
    };
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${index}`, "y".repeat(5000)]),
    );

    const small = JSON.stringify(preview({ value: "y".repeat(5000) }));
    const large = preview(fields);
    const many = JSON.stringify(
      preview(Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`${index}`, "y"]))),
    );

    expect(large.title.text).toHaveLength(150);
    expect(small).toContain("y...");
    expect(JSON.stringify(large)).toMatch(/\+\d+ more fields/u);
    expect(JSON.stringify(large).length).toBeLessThan(3000);
    expect(many).toContain("+1990 more fields");
    expect(many.length).toBeLessThan(3000);
  });

  it.each([
    ["eve's request for a person's identity", { principalIds: ["alice"] }, true],
    ["an ordinary approval", undefined, false],
  ])("shows the whole prompt of %s beside its card: %s", (_label, audience, whole) => {
    const prompt =
      'Approve Gh with your identity? Approving also lets later actions use your identity, on any account, until someone else sends a message after this request. The latest message from someone else, from "bob", reads: "<!here> open it". It runs with "command": "gh pr create".';
    const request: Interaction = {
      ...makeRequest({
        call: { callId: "call_gh", name: "gh", input: { command: "gh pr create" } },
        display: "confirmation",
        kind: "approval",
        prompt,
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Cancel" },
        ],
      }),
      ...(audience !== undefined && { audience }),
    };

    const parts = renderInteractionPostParts(request);
    const shown = JSON.stringify([...parts.controls.blocks, ...(parts.details?.blocks ?? [])]);

    // A card shows only the start of its prompt, which cuts the disclosure short and leaves out
    // the quote after it, so eve's request needs the whole prompt beside the card.
    if (whole) expect(shown).toContain("until someone else sends a message after this request");
    expect(shown.includes("&lt;!here&gt; open it")).toBe(whole);
    expect(shown).not.toContain("<!here>");
    expect(JSON.stringify(parts.controls.blocks)).not.toContain("<!here>");
  });

  it("renders model-supplied prompts and tool input literally", () => {
    const request = makeRequest({
      call: { callId: "call_post", name: "post", input: { text: "<!here> *bold*" } },
      display: "confirmation",
      kind: "approval",
      prompt: "<!channel> open <https://evil.example|https://trusted.example> & approve",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    });
    const prompt =
      "&lt;!channel&gt; open &lt;https://evil.example|https://trusted.example&gt; &amp; approve";

    const [container] = renderInteractionBlocks(request) as [
      { child_blocks: unknown[]; title: { text: string; type: string } },
    ];
    // `plain_text` and `rich_text` text never parse mentions, links, or formatting.
    expect(container.title).toEqual({ type: "plain_text", text: request.request.prompt });
    expect(JSON.stringify(container.child_blocks[0])).toContain(
      '{"type":"text","text":"<!here> *bold*"}',
    );
    expect(renderInteractionPostParts(request).controls.text).toBe(prompt);

    const [section] = renderInteractionBlocks({
      ...request,
      request: { kind: "question", prompt: request.request.prompt },
    }) as [{ text: { text: string } }];
    expect(section.text.text).toBe(prompt);
  });

  it("renders a radio_buttons widget for select-display requests with ≤6 options", () => {
    const blocks = renderInteractionBlocks(
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
    expect(widget.action_id).toBe(`${ANSWER_ACTION_PREFIX}call_abc123`);
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

    const blocks = renderInteractionBlocks(
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
    expect(widget.action_id).toBe(`${ANSWER_ACTION_PREFIX}call_abc123`);
    expect(widget.options).toHaveLength(8);
  });

  it.each([
    ["radio_buttons", 2],
    ["static_select", 8],
  ])("preselects initialOptionId on %s and adds a button that submits it", (type, count) => {
    const options = Array.from({ length: count }, (_, i) => ({
      id: `team_${i}`,
      label: `Team ${i}`,
    }));
    const blocks = renderInteractionBlocks(
      makeRequest({ display: "select", options, initialOptionId: "team_1" }),
    );

    const actions = blocks[1] as {
      block_id: string;
      elements: [
        { type: string; initial_option: unknown; options: unknown[] },
        { action_id: string; style: string; text: { text: string }; value: string },
      ];
    };
    const [widget, button] = actions.elements;
    expect(widget.type).toBe(type);
    expect(widget.initial_option).toEqual(widget.options[1]);
    expect(button).toMatchObject({ style: "primary", text: { text: "Use Team 1" } });
    expect(answerFromSlackAction({ actionId: button.action_id, value: button.value })).toEqual({
      response: { interactionId: "call_abc123", optionId: "team_1" },
    });
    // A click on the button reads as the option it submits, not as the button's text.
    expect(answerLabelOf({ blockId: actions.block_id, label: button.text.text })).toBe("Team 1");
  });

  it("renders a 'Type your answer' freeform button when the request has no options", () => {
    const blocks = renderInteractionBlocks(makeRequest({ prompt: "What's the date range?" }));

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
    const blocks = renderInteractionBlocks(
      makeRequest({
        allowFreeform: true,
        options: [{ id: "yes", label: "Approve" }],
      }),
    );
    // current behavior: options take precedence; freeform button is the
    // fallback when no options are supplied. This documents the
    // option-only path; freeform-with-options is left as future work.
    expect(blocks).toHaveLength(1);
    const card = blocks[0] as { actions: Array<{ action_id: string }> };
    const ids = card.actions.map((e) => e.action_id);
    for (const id of ids) {
      expect(id.startsWith(ANSWER_ACTION_PREFIX)).toBe(true);
    }
  });

  it("round-trips a button click without parsing collisions on underscore-bearing call ids", () => {
    const request = makeRequest({
      interactionId: "call_with_many_underscores_99",
      options: [{ id: "yes_please", label: "Yes please" }],
    });

    const blocks = renderInteractionBlocks(request);
    const button = (blocks[0] as { actions: Array<{ action_id: string; value: string }> })
      .actions[0]!;

    const response = answerFromSlackAction({ actionId: button.action_id, value: button.value });
    expect(response).toEqual({
      response: {
        interactionId: "call_with_many_underscores_99",
        optionId: "yes_please",
      },
    });
  });

  it("isFreeformAction recognizes only the freeform prefix", () => {
    expect(isFreeformAction(`${HITL_FREEFORM_ACTION_PREFIX}call_abc`)).toBe(true);
    expect(isFreeformAction(`${ANSWER_ACTION_PREFIX}call_abc`)).toBe(false);
  });

  it("preserves the return route on a freeform question", () => {
    const blocks = renderInteractionBlocks(
      makeRequest({ interactionId: "question_freeform", options: undefined }),
      { channelId: "C777", threadTs: "7.7" },
    );
    const actionId = (blocks[1] as { elements: Array<{ action_id: string }> }).elements[0]!
      .action_id;

    expect(actionId).toBe("eve_input_freeform:route:C777:7.7:question_freeform");
    expect(decodeFreeformHitlActionId(actionId)?.requestId).toBe("question_freeform");
  });

  it("truncates section-block prompts past the Slack 3000-char cap", () => {
    const longPrompt = "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500);
    const blocks = renderInteractionBlocks(makeRequest({ prompt: longPrompt }));
    const promptBlock = blocks[0] as { text: { text: string } };
    expect(promptBlock.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(promptBlock.text.text.endsWith("...")).toBe(true);
  });

  it("round-trips a radio click without parsing collisions on underscore-bearing call ids", () => {
    const request = makeRequest({
      interactionId: "call_with_many_underscores_99",
      display: "select",
      options: [{ id: "weekly_report", label: "Weekly report" }],
    });

    const blocks = renderInteractionBlocks(request);
    const widget = (
      blocks[1] as { elements: Array<{ action_id: string; options: Array<{ value: string }> }> }
    ).elements[0]!;

    const response = answerFromSlackAction({
      actionId: widget.action_id,
      selectedOptionValue: widget.options[0]!.value,
    });
    expect(response).toEqual({
      response: {
        interactionId: "call_with_many_underscores_99",
        optionId: "weekly_report",
      },
    });
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

  it("shows an escaped card prompt literally in the modal title and section", () => {
    const view = buildFreeformModalView({
      metadata: {
        continuationToken: "slack:C01:1.0",
        channelId: "C01",
        threadTs: "1.0",
        messageTs: "1.1",
        requestId: "call_abc",
      },
      prompt: "Ship A &amp; B &lt;now&gt;?",
    });

    expect(view.title).toEqual({ type: "plain_text", text: "Ship A & B <now>?" });
    expect((view.blocks as Array<{ text?: { text?: string } }>)[0]?.text?.text).toBe(
      "Ship A &amp; B &lt;now&gt;?",
    );
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
    const blocks = buildAnsweredBlocks({ promptBlocks: [], answerLabel: "Cancel" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: { text: ":white_check_mark: *Cancel*" },
    });
  });

  it("escapes Slack control sequences in a typed answer", () => {
    const [answer] = buildAnsweredBlocks({ promptBlocks: [], answerLabel: "<!channel>" }) as [
      { text: { text: string } },
    ];
    expect(answer.text.text).toBe(":white_check_mark: *&lt;!channel&gt;*");
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
