import { describe, expect, it } from "vitest";

import {
  DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
  buildFreeformModalResponse,
  deriveComponentAnswers,
  deriveModalAnswers,
  isDiscordFreeformComponent,
  renderInteractionComponents,
} from "#public/channels/discord/hitl.js";
import type {
  DiscordComponentInteraction,
  DiscordModalSubmitInteraction,
} from "#public/channels/discord/inbound.js";
import type { Interaction } from "#protocol/session-projection/reader.js";

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

function request(
  overrides: Partial<Interaction["request"]> &
    Partial<Pick<Interaction, "interactionId" | "call">> = {},
): Interaction {
  const {
    interactionId = "call_1",
    call = { callId: "call_1", name: "ask_question", input: {} },
    ...request
  } = overrides;
  return {
    interactionId,
    call,
    status: "open",
    turnId: "turn_0",
    stepIndex: 0,
    request: { prompt: "Choose one", kind: "question", ...request },
  };
}

describe("renderInteractionComponents", () => {
  it("renders select requests as a string select and decodes selected values", () => {
    const components = renderInteractionComponents(
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
      deriveComponentAnswers({
        ...BASE_COMPONENT,
        componentType: 3,
        customId: select.custom_id,
        messageId: "M01",
        type: 3,
        values: ["weekly"],
      }),
    ).toEqual([{ optionId: "weekly", interactionId: "call_1" }]);
  });

  it("refuses a select option id that Discord would truncate", () => {
    const render = (id: string) =>
      renderInteractionComponents(
        request({
          display: "select",
          options: [
            { id, label: "Long" },
            { id: "b", label: "B" },
          ],
        }),
      );

    expect(() => render("x".repeat(100))).not.toThrow();
    expect(() => render("x".repeat(101))).toThrow(
      "discordChannel: select option ids must be at most 100 characters",
    );
  });

  it("renders freeform requests as a modal-opening button", () => {
    const components = renderInteractionComponents(request({ allowFreeform: true }));
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

describe("deriveModalAnswers", () => {
  it("decodes freeform modal submissions", () => {
    const customId = (
      renderInteractionComponents(request({ allowFreeform: true }))[0] as {
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

    expect(deriveModalAnswers(interaction)).toEqual([
      { interactionId: "call_1", text: "freeform answer" },
    ]);
  });
});
