import { describe, expect, it } from "vitest";

import {
  DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
  buildFreeformModalResponse,
  deriveComponentInputResponses,
  deriveModalInputResponses,
  isDiscordFreeformComponent,
  renderInputRequestComponents,
} from "#public/channels/discord/hitl.js";
import type {
  DiscordComponentInteraction,
  DiscordModalSubmitInteraction,
} from "#public/channels/discord/inbound.js";
import type { InputRequest } from "#runtime/input/types.js";

const BASE_COMPONENT: Omit<
  DiscordComponentInteraction,
  "componentType" | "customId" | "messageId" | "type" | "values"
> = {
  applicationId: "APP1",
  channelId: "C01",
  id: "I01",
  raw: {},
  token: "tok",
  user: { id: "U01", isBot: false, username: "ada" },
};

function request(overrides?: Partial<InputRequest>): InputRequest {
  return {
    action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
    prompt: "Choose one",
    requestId: "call_1",
    ...overrides,
  };
}

describe("renderInputRequestComponents", () => {
  it("renders confirmation options as buttons and decodes the clicked option", () => {
    const components = renderInputRequestComponents(
      request({
        display: "confirmation",
        options: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "deny", label: "Deny", style: "danger" },
        ],
      }),
    );
    const firstRow = components[0] as { components: Array<{ custom_id: string }> };
    const approveCustomId = firstRow.components[0]!.custom_id;

    expect(
      deriveComponentInputResponses({
        ...BASE_COMPONENT,
        componentType: 2,
        customId: approveCustomId,
        messageId: "M01",
        type: 3,
        values: [],
      }),
    ).toEqual([{ optionId: "approve", requestId: "call_1" }]);
  });

  it("renders select requests as a string select and decodes selected values", () => {
    const components = renderInputRequestComponents(
      request({
        display: "select",
        options: [
          { id: "weekly", label: "Weekly" },
          { id: "daily", label: "Daily" },
        ],
      }),
    );
    const select = (components[0] as { components: Array<{ custom_id: string }> }).components[0]!;

    expect(
      deriveComponentInputResponses({
        ...BASE_COMPONENT,
        componentType: 3,
        customId: select.custom_id,
        messageId: "M01",
        type: 3,
        values: ["weekly"],
      }),
    ).toEqual([{ optionId: "weekly", requestId: "call_1" }]);
  });

  it("renders freeform requests as a modal-opening button", () => {
    const components = renderInputRequestComponents(request({ allowFreeform: true }));
    const customId = (components[0] as { components: Array<{ custom_id: string }> }).components[0]!
      .custom_id;

    expect(isDiscordFreeformComponent(customId)).toBe(true);
    expect(buildFreeformModalResponse({ customId, prompt: "Tell me more" })).toMatchObject({
      data: {
        title: "Tell me more",
      },
      type: 9,
    });
  });
});

describe("deriveModalInputResponses", () => {
  it("decodes freeform modal submissions", () => {
    const customId = (
      renderInputRequestComponents(request({ allowFreeform: true }))[0] as {
        components: Array<{ custom_id: string }>;
      }
    ).components[0]!.custom_id;
    const modalResponse = buildFreeformModalResponse({ customId, prompt: "Answer" });
    const modalCustomId = (modalResponse.data as { custom_id: string }).custom_id;

    const interaction: DiscordModalSubmitInteraction = {
      ...BASE_COMPONENT,
      customId: modalCustomId,
      messageId: "M01",
      textInputs: { [DISCORD_HITL_FREEFORM_TEXT_INPUT_ID]: "freeform answer" },
      type: 5,
    };

    expect(deriveModalInputResponses(interaction)).toEqual([
      { requestId: "call_1", text: "freeform answer" },
    ]);
  });
});
