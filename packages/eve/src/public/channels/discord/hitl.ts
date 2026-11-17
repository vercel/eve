import {
  DISCORD_INTERACTION_RESPONSE_TYPE,
  type DiscordComponentInteraction,
  type DiscordModalSubmitInteraction,
} from "#public/channels/discord/inbound.js";
import { parseAnswer, type ValidatedAnswer } from "#shared/input.js";
import type { InteractionOption } from "#protocol/session-events/families/interaction.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import { chunk, truncate } from "#public/channels/text.js";

export const DISCORD_COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
} as const;

export const DISCORD_HITL_CUSTOM_ID_PREFIX = "eve_input:";

export const DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX = "eve_input_freeform:";

export const DISCORD_HITL_FREEFORM_TEXT_INPUT_ID = "eve_freeform_text";

const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
const DISCORD_LABEL_MAX_LENGTH = 80;
const DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH = 100;
const DISCORD_MODAL_TITLE_MAX_LENGTH = 45;
const DISCORD_ACTION_ROW_LIMIT = 5;
const DISCORD_SELECT_OPTION_LIMIT = 25;

interface HitlCustomIdPayload {
  readonly optionId?: string;
  readonly requestId: string;
}

export function renderInteractionComponents(
  request: Interaction,
): readonly Readonly<Record<string, unknown>>[] {
  const options = request.request.options;
  const acceptsFreeform =
    request.request.allowFreeform === true || !options || options.length === 0;

  if (options && options.length > 0 && request.request.display === "select") {
    const shown = options.slice(0, DISCORD_SELECT_OPTION_LIMIT);
    const initial = shown.find((option) => option.id === request.request.initialOptionId);
    const rows: Record<string, unknown>[] = [
      {
        components: [
          {
            custom_id: encodeHitlCustomId(DISCORD_HITL_CUSTOM_ID_PREFIX, {
              requestId: request.interactionId,
            }),
            options: shown.map((option) => {
              const result: Record<string, unknown> = {
                label: truncate(option.label, DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH),
                value: selectOptionValue(option.id),
              };
              if (option.description !== undefined) {
                result.description = truncate(
                  option.description,
                  DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH,
                );
              }
              if (option === initial) result.default = true;
              return result;
            }),
            placeholder: "Choose an option",
            type: DISCORD_COMPONENT_TYPE.STRING_SELECT,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      },
    ];
    const useId =
      initial === undefined
        ? undefined
        : hitlCustomId(DISCORD_HITL_CUSTOM_ID_PREFIX, {
            optionId: initial.id,
            requestId: request.interactionId,
          });
    if (
      initial !== undefined &&
      useId !== undefined &&
      useId.length <= DISCORD_CUSTOM_ID_MAX_LENGTH
    ) {
      rows.push({
        components: [
          {
            custom_id: useId,
            label: truncate(`Use ${initial.label}`, DISCORD_LABEL_MAX_LENGTH),
            style: toDiscordButtonStyle("primary"),
            type: DISCORD_COMPONENT_TYPE.BUTTON,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      });
    }
    return rows;
  }

  if (options && options.length > 0) {
    return chunk(options.slice(0, DISCORD_ACTION_ROW_LIMIT * DISCORD_ACTION_ROW_LIMIT), 5).map(
      (row) => ({
        components: row.map((option) => ({
          custom_id: encodeHitlCustomId(DISCORD_HITL_CUSTOM_ID_PREFIX, {
            optionId: option.id,
            requestId: request.interactionId,
          }),
          label: truncate(option.label, DISCORD_LABEL_MAX_LENGTH),
          style: toDiscordButtonStyle(option.style),
          type: DISCORD_COMPONENT_TYPE.BUTTON,
        })),
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      }),
    );
  }

  if (acceptsFreeform) {
    return [
      {
        components: [
          {
            custom_id: encodeHitlCustomId(DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX, {
              requestId: request.interactionId,
            }),
            label: "Type your answer",
            style: 1,
            type: DISCORD_COMPONENT_TYPE.BUTTON,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      },
    ];
  }

  return [];
}

export function buildFreeformModalResponse(input: {
  readonly customId: string;
  readonly prompt: string | undefined;
}): Record<string, unknown> {
  const payload = decodeHitlCustomId(input.customId, DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX);
  if (!payload) {
    throw new Error("discordChannel: freeform custom_id is malformed.");
  }

  return {
    data: {
      components: [
        {
          components: [
            {
              custom_id: DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
              label: "Answer",
              max_length: 4000,
              min_length: 1,
              placeholder: "Type your answer here...",
              required: true,
              style: 2,
              type: DISCORD_COMPONENT_TYPE.TEXT_INPUT,
            },
          ],
          type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
        },
      ],
      custom_id: encodeHitlCustomId(DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX, {
        requestId: payload.requestId,
      }),
      title: truncate(input.prompt ?? "Your answer", DISCORD_MODAL_TITLE_MAX_LENGTH),
    },
    type: DISCORD_INTERACTION_RESPONSE_TYPE.MODAL,
  };
}

export function isDiscordFreeformComponent(customId: string): boolean {
  return decodeHitlCustomId(customId, DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX) !== null;
}

export function deriveComponentAnswers(
  interaction: DiscordComponentInteraction,
): readonly ValidatedAnswer[] {
  const payload = decodeHitlCustomId(interaction.customId, DISCORD_HITL_CUSTOM_ID_PREFIX);
  if (!payload) return [];

  if (payload.optionId !== undefined) {
    return [parseAnswer({ interactionId: payload.requestId, optionId: payload.optionId })];
  }

  const selected = interaction.values[0];
  if (selected !== undefined) {
    return [parseAnswer({ interactionId: payload.requestId, optionId: selected })];
  }

  return [];
}

export function deriveModalAnswers(
  interaction: DiscordModalSubmitInteraction,
): readonly ValidatedAnswer[] {
  const payload = decodeHitlCustomId(interaction.customId, DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX);
  const text = interaction.textInputs[DISCORD_HITL_FREEFORM_TEXT_INPUT_ID];
  if (!payload || text === undefined) return [];
  return [parseAnswer({ interactionId: payload.requestId, text })];
}

function encodeHitlCustomId(prefix: string, payload: HitlCustomIdPayload): string {
  const customId = hitlCustomId(prefix, payload);
  if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
    throw new Error("discordChannel: HITL custom_id exceeded Discord's 100-character limit.");
  }
  return customId;
}

function hitlCustomId(prefix: string, payload: HitlCustomIdPayload): string {
  const fields =
    payload.optionId === undefined ? [payload.requestId] : [payload.requestId, payload.optionId];
  return `${prefix}${JSON.stringify(fields)}`;
}

function decodeHitlCustomId(customId: string, prefix: string): HitlCustomIdPayload | null {
  if (!customId.startsWith(prefix)) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(customId.slice(prefix.length));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2) return null;
  const [requestId, optionId] = fields as unknown[];
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  if (optionId === undefined) return { requestId };
  return typeof optionId === "string" ? { optionId, requestId } : null;
}

function selectOptionValue(optionId: string): string {
  if (optionId.length > DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH) {
    throw new Error(
      `discordChannel: select option ids must be at most ${DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH} characters, Discord's option value limit.`,
    );
  }
  return optionId;
}

function toDiscordButtonStyle(style: InteractionOption["style"]): number {
  if (style === "primary") return 1;
  if (style === "danger") return 4;
  return 2;
}
