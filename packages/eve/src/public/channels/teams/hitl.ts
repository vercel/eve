/**
 * Teams Adaptive Card rendering and decode helpers for eve HITL prompts.
 */

import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type {
  TeamsActivity,
  TeamsInvokeActivity,
  TeamsMessageActivity,
} from "#public/channels/teams/inbound.js";
import type { TeamsAttachment, TeamsMessageBody } from "#public/channels/teams/api.js";
import {
  TEAMS_ADAPTIVE_CARD_ACTION_LIMIT,
  TEAMS_ADAPTIVE_CARD_ACTION_TITLE_MAX_LENGTH,
  TEAMS_ADAPTIVE_CARD_CHOICE_TITLE_MAX_LENGTH,
  TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH,
} from "#public/channels/teams/limits.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";

/** Adaptive Card attachment content type used by Teams. */
export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** Hidden data property used by eve HITL Adaptive Card actions. */
export const TEAMS_HITL_DATA_KEY = "eve_input";

/** ChoiceSet input id used for select-style HITL requests. */
export const TEAMS_HITL_CHOICE_INPUT_ID = "eve_option";

/** Text input id used for freeform HITL requests. */
export const TEAMS_HITL_FREEFORM_INPUT_ID = "eve_freeform_text";

/** Renders one input request as a Teams message body containing an Adaptive Card. */
export function renderInputRequestMessage(
  request: InputRequest,
  options: {
    readonly adaptiveCardVersion?: string;
    readonly replyToActivityId?: string;
  } = {},
): TeamsMessageBody {
  const details = formatApprovalInput(request);
  const renderedDetails = details ? truncate(details, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH) : null;
  return {
    attachments: [renderInputRequestAttachment(request, options)],
    text: renderedDetails ? `${request.prompt}\n\nTool input:\n${renderedDetails}` : request.prompt,
  };
}

/**
 * Renders one input request as a Teams Adaptive Card attachment.
 * `options.adaptiveCardVersion` sets the card schema version (default "1.5").
 * Long prompt, choice, and action text is truncated to Teams card limits.
 */
export function renderInputRequestAttachment(
  request: InputRequest,
  options: {
    readonly adaptiveCardVersion?: string;
    readonly replyToActivityId?: string;
  } = {},
): TeamsAttachment {
  const details = formatApprovalInput(request);
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    actions: renderActions(request, options.replyToActivityId),
    body: [
      {
        text: truncate(request.prompt, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH),
        type: "TextBlock",
        wrap: true,
      },
      ...(details
        ? [
            {
              fontType: "Monospace",
              text: truncate(details, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH),
              type: "TextBlock",
              wrap: true,
            },
          ]
        : []),
      ...renderInputs(request),
    ],
    type: "AdaptiveCard",
    version: options.adaptiveCardVersion ?? "1.5",
  };

  return {
    content: parseJsonObject(card),
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  };
}

/** Renders an answered Teams card that replaces a pending HITL prompt. */
export function renderAnsweredInputRequestMessage(input: {
  readonly label?: string;
  readonly prompt: string;
}): TeamsMessageBody {
  return {
    attachments: [
      {
        content: parseJsonObject({
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          body: [
            {
              text: truncate(input.prompt, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH),
              type: "TextBlock",
              wrap: true,
            },
            {
              color: "good",
              text: input.label ? `Answered: ${input.label}` : "Answered",
              type: "TextBlock",
              wrap: true,
            },
          ],
          type: "AdaptiveCard",
          version: "1.5",
        }),
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
      },
    ],
    text: input.label ? `Answered: ${input.label}` : "Answered",
  };
}

/** Returns true when a Teams activity carries an eve HITL submit payload. */
export function isTeamsInputResponseActivity(activity: TeamsActivity): boolean {
  return deriveTeamsInputResponses(activity).length > 0;
}

/**
 * Decodes the eve HITL submit payload from a Teams activity. Returns a single
 * `InputResponse` (option selection, freeform text, or a bare requestId
 * acknowledgement), or an empty array when the activity has no recognizable
 * HITL payload or requestId.
 */
export function deriveTeamsInputResponses(activity: TeamsActivity): readonly InputResponse[] {
  const value = readActivityValue(activity);
  if (!value) return [];
  const payload = readHitlPayload(value);
  if (!payload) return [];

  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return [];

  const optionId =
    typeof payload.optionId === "string"
      ? payload.optionId
      : typeof value[TEAMS_HITL_CHOICE_INPUT_ID] === "string"
        ? value[TEAMS_HITL_CHOICE_INPUT_ID]
        : undefined;
  const text =
    typeof value[TEAMS_HITL_FREEFORM_INPUT_ID] === "string"
      ? value[TEAMS_HITL_FREEFORM_INPUT_ID]
      : undefined;

  if (optionId !== undefined) return [{ optionId, requestId }];
  if (text !== undefined) return [{ requestId, text }];
  return [{ requestId }];
}

/**
 * Builds the HTTP body Teams expects after an Adaptive Card invoke action.
 * Defaults to statusCode 200 and message "Answer received."; `type` is always
 * the Teams activity-message content type.
 */
/** Reads the recorded thread root carried by an eve HITL card submission. */
export function readTeamsInputReplyToActivityId(activity: TeamsActivity): string | null {
  const value = readActivityValue(activity);
  if (!value) return null;
  const payload = readHitlPayload(value);
  return payload && typeof payload.replyToActivityId === "string"
    ? payload.replyToActivityId
    : null;
}

export function teamsInvokeResponse(
  input: {
    readonly message?: string;
    readonly statusCode?: number;
  } = {},
): Record<string, unknown> {
  return {
    statusCode: input.statusCode ?? 200,
    type: "application/vnd.microsoft.activity.message",
    value: input.message ?? "Answer received.",
  };
}

function renderInputs(request: InputRequest): readonly Record<string, unknown>[] {
  if (request.display === "select" && request.options && request.options.length > 0) {
    return [
      {
        choices: request.options.map((option) => ({
          title: truncate(option.label, TEAMS_ADAPTIVE_CARD_CHOICE_TITLE_MAX_LENGTH),
          value: option.id,
        })),
        id: TEAMS_HITL_CHOICE_INPUT_ID,
        isMultiSelect: false,
        style: "compact",
        type: "Input.ChoiceSet",
      },
    ];
  }

  if (request.allowFreeform === true || !request.options || request.options.length === 0) {
    return [
      {
        id: TEAMS_HITL_FREEFORM_INPUT_ID,
        isMultiline: true,
        placeholder: "Type your answer",
        type: "Input.Text",
      },
    ];
  }

  return [];
}

function renderActions(
  request: InputRequest,
  replyToActivityId: string | undefined,
): readonly Record<string, unknown>[] {
  const payload = (optionId?: string): Record<string, unknown> => {
    const value: Record<string, unknown> = { requestId: request.requestId };
    if (replyToActivityId !== undefined) value.replyToActivityId = replyToActivityId;
    if (optionId !== undefined) value.optionId = optionId;
    return value;
  };
  const options = request.options;
  if (options && options.length > 0 && request.display !== "select") {
    return options.slice(0, TEAMS_ADAPTIVE_CARD_ACTION_LIMIT).map((option) => ({
      data: {
        [TEAMS_HITL_DATA_KEY]: payload(option.id),
      },
      title: truncate(option.label, TEAMS_ADAPTIVE_CARD_ACTION_TITLE_MAX_LENGTH),
      type: "Action.Submit",
    }));
  }

  return [
    {
      data: {
        [TEAMS_HITL_DATA_KEY]: payload(),
      },
      title: "Submit",
      type: "Action.Submit",
    },
  ];
}

function readActivityValue(activity: TeamsActivity): Record<string, unknown> | null {
  if (activity.type === "message") return readMessageValue(activity);
  if (activity.type === "invoke") return readInvokeValue(activity);
  return null;
}

function readMessageValue(activity: TeamsMessageActivity): Record<string, unknown> | null {
  return activity.value ?? null;
}

function readInvokeValue(activity: TeamsInvokeActivity): Record<string, unknown> | null {
  const value = activity.value;
  if (!value) return null;
  const action = isObject(value.action) ? value.action : null;
  const data = action && isObject(action.data) ? action.data : null;
  return data ?? value;
}

function readHitlPayload(value: Record<string, unknown>): Record<string, unknown> | null {
  const direct = value[TEAMS_HITL_DATA_KEY];
  if (isObject(direct)) return direct;
  const action = isObject(value.action) ? value.action : null;
  const data = action && isObject(action.data) ? action.data : null;
  const nested = data?.[TEAMS_HITL_DATA_KEY];
  return isObject(nested) ? nested : null;
}

function formatApprovalInput(request: InputRequest): string | null {
  if (
    request.display !== "confirmation" ||
    request.options?.length !== 2 ||
    request.options[0]?.id !== "approve" ||
    request.options[1]?.id !== "deny"
  ) {
    return null;
  }
  const json = JSON.stringify(request.action.input, null, 2);
  return json === "{}" ? null : json;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}
