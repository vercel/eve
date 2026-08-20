/**
 * Discord HITL component rendering + decode helpers.
 *
 * Discord components carry a `custom_id` with a 100-character cap. eve
 * encodes only the request id and, for buttons, the selected option id.
 */

import {
  DISCORD_INTERACTION_RESPONSE_TYPE,
  type DiscordComponentInteraction,
  type DiscordModalSubmitInteraction,
} from "#public/channels/discord/inbound.js";
import type { InputOption, InputRequest, InputResponse } from "#runtime/input/types.js";

/** Maps Discord component kinds (ACTION_ROW, BUTTON, STRING_SELECT, TEXT_INPUT) to their wire `type` integers used in component payloads. */
export const DISCORD_COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
} as const;

/** Custom id prefix for selectable HITL controls. */
export const DISCORD_HITL_CUSTOM_ID_PREFIX = "eve_input:";

/** Custom id prefix for the button/modal freeform flow. */
export const DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX = "eve_input_freeform:";

/** Text-input id inside the freeform modal. */
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

/**
 * Renders an input request into Discord action-row components: a string-select
 * for `display: "select"` with options, else option buttons chunked into rows,
 * else a freeform-answer button when freeform is accepted. Empty array when no
 * control applies.
 */
export function renderInputRequestComponents(
  request: InputRequest,
): readonly Readonly<Record<string, unknown>>[] {
  const options = request.options;
  const acceptsFreeform = request.allowFreeform === true || !options || options.length === 0;

  if (options && options.length > 0 && request.display === "select") {
    return [
      {
        components: [
          {
            custom_id: encodeHitlCustomId(DISCORD_HITL_CUSTOM_ID_PREFIX, {
              requestId: request.requestId,
            }),
            options: options.slice(0, DISCORD_SELECT_OPTION_LIMIT).map((option) => {
              const result: Record<string, unknown> = {
                label: truncate(option.label, DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH),
                value: truncate(option.id, DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH),
              };
              if (option.description !== undefined) {
                result.description = truncate(
                  option.description,
                  DISCORD_SELECT_OPTION_TEXT_MAX_LENGTH,
                );
              }
              return result;
            }),
            placeholder: "Choose an option",
            type: DISCORD_COMPONENT_TYPE.STRING_SELECT,
          },
        ],
        type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      },
    ];
  }

  if (options && options.length > 0) {
    return chunk(options.slice(0, DISCORD_ACTION_ROW_LIMIT * DISCORD_ACTION_ROW_LIMIT), 5).map(
      (row) => ({
        components: row.map((option) => ({
          custom_id: encodeHitlCustomId(DISCORD_HITL_CUSTOM_ID_PREFIX, {
            optionId: option.id,
            requestId: request.requestId,
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
              requestId: request.requestId,
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

/** Builds a Discord modal response for one freeform HITL request. */
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

/** Returns true when a component custom id starts the freeform modal flow. */
export function isDiscordFreeformComponent(customId: string): boolean {
  return decodeHitlCustomId(customId, DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX) !== null;
}

/**
 * Decodes an eve HITL component interaction into input responses. Empty array
 * if the custom id is not an eve HITL id; otherwise one response from the
 * encoded option id (buttons) or the first selected value (selects).
 */
export function deriveComponentInputResponses(
  interaction: DiscordComponentInteraction,
): readonly InputResponse[] {
  const payload = decodeHitlCustomId(interaction.customId, DISCORD_HITL_CUSTOM_ID_PREFIX);
  if (!payload) return [];

  if (payload.optionId !== undefined) {
    return [{ optionId: payload.optionId, requestId: payload.requestId }];
  }

  const selected = interaction.values[0];
  if (selected !== undefined) {
    return [{ optionId: selected, requestId: payload.requestId }];
  }

  return [];
}

/**
 * Decodes an eve freeform modal submission into a single text input response.
 * Empty array unless the custom id matches the freeform prefix and the freeform
 * text field is present.
 */
export function deriveModalInputResponses(
  interaction: DiscordModalSubmitInteraction,
): readonly InputResponse[] {
  const payload = decodeHitlCustomId(interaction.customId, DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX);
  const text = interaction.textInputs[DISCORD_HITL_FREEFORM_TEXT_INPUT_ID];
  if (!payload || text === undefined) return [];
  return [{ requestId: payload.requestId, text }];
}

function encodeHitlCustomId(prefix: string, payload: HitlCustomIdPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const customId = `${prefix}${encoded}`;
  if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
    throw new Error("discordChannel: HITL custom_id exceeded Discord's 100-character limit.");
  }
  return customId;
}

function decodeHitlCustomId(customId: string, prefix: string): HitlCustomIdPayload | null {
  if (!customId.startsWith(prefix)) return null;
  try {
    const decoded = Buffer.from(customId.slice(prefix.length), "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as {
      optionId?: unknown;
      requestId?: unknown;
    };
    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) return null;
    const result: HitlCustomIdPayload = { requestId: parsed.requestId };
    if (typeof parsed.optionId === "string") {
      return { ...result, optionId: parsed.optionId };
    }
    return result;
  } catch {
    return null;
  }
}

function toDiscordButtonStyle(style: InputOption["style"]): number {
  if (style === "primary") return 1;
  if (style === "danger") return 4;
  return 2;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
