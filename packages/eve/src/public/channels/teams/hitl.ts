import { parseAnswer, type ValidatedAnswer } from "#shared/input.js";
import type { Interaction } from "#channel/interaction-prompts.js";
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
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { truncate } from "#public/channels/text.js";

export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

export const TEAMS_HITL_DATA_KEY = "eve_input";

export const TEAMS_HITL_CHOICE_INPUT_ID = "eve_option";

export const TEAMS_HITL_FREEFORM_INPUT_ID = "eve_freeform_text";

export const TEAMS_HITL_REQUEST_KIND_KEY = "kind";

export const TEAMS_HITL_PROMPT_KEY = "prompt";

function literalText(
  text: string,
  run: { readonly color?: string; readonly fontType?: "Monospace" } = {},
): Record<string, unknown> {
  return {
    inlines: [
      {
        ...(run.color !== undefined && { color: run.color }),
        ...(run.fontType !== undefined && { fontType: run.fontType }),
        text: truncate(text, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH),
        type: "TextRun",
      },
    ],
    type: "RichTextBlock",
  };
}

export function renderInteractionMessage(
  request: Interaction,
  options: {
    readonly adaptiveCardVersion?: string;
    readonly replyToActivityId?: string;
  } = {},
): TeamsMessageBody {
  const details = formatApprovalInput(request);
  const renderedDetails = details ? truncate(details, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH) : null;
  return {
    attachments: [renderInteractionAttachment(request, options)],
    text: renderedDetails
      ? `${request.request.prompt}\n\nTool input:\n${renderedDetails}`
      : request.request.prompt,
    textFormat: "plain",
  };
}

export function renderInteractionAttachment(
  request: Interaction,
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
      literalText(request.request.prompt),
      ...(details ? [literalText(details, { fontType: "Monospace" })] : []),
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

export function renderAnsweredInteractionMessage(input: {
  readonly by?: string;
  readonly includeText?: boolean;
  readonly label?: string;
  readonly prompt: string;
}): TeamsMessageBody {
  const answered = input.by ? `Answered by ${input.by}` : "Answered";
  const text = input.label ? `${answered}: ${input.label}` : answered;
  const result = renderSettledInputRequestMessage(input.prompt, { color: "good", text });
  if (input.includeText !== false) return { ...result, text, textFormat: "plain" };
  return result;
}

export function renderInactiveInputRequestMessage(
  prompt: string | undefined,
  label: string,
): TeamsMessageBody {
  return renderSettledInputRequestMessage(prompt, { text: label });
}

function renderSettledInputRequestMessage(
  prompt: string | undefined,
  status: { readonly color?: string; readonly text: string },
): TeamsMessageBody {
  const promptBlocks = prompt === undefined ? [] : [literalText(prompt)];
  return {
    attachments: [
      {
        content: parseJsonObject({
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          body: [...promptBlocks, literalText(status.text, { color: status.color })],
          type: "AdaptiveCard",
          version: "1.5",
        }),
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
      },
    ],
  };
}

export function isTeamsAnswerActivity(activity: TeamsActivity): boolean {
  return deriveTeamsAnswers(activity).length > 0;
}

export function isTeamsToolApprovalResponseActivity(activity: TeamsActivity): boolean {
  const value = readActivityValue(activity);
  const payload = value && readHitlPayload(value);
  return payload?.[TEAMS_HITL_REQUEST_KIND_KEY] === "tool-approval";
}

export function readTeamsToolApprovalPrompt(activity: TeamsActivity): string | undefined {
  return isTeamsToolApprovalResponseActivity(activity) ? readTeamsInputPrompt(activity) : undefined;
}

export function readTeamsInputPrompt(activity: TeamsActivity): string | undefined {
  const value = readActivityValue(activity);
  const payload = value && readHitlPayload(value);
  const prompt = payload?.[TEAMS_HITL_PROMPT_KEY];
  return typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
}

export function deriveTeamsAnswers(activity: TeamsActivity): readonly ValidatedAnswer[] {
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

  if (optionId !== undefined) return [parseAnswer({ interactionId: requestId, optionId })];
  if (text !== undefined) return [parseAnswer({ interactionId: requestId, text })];
  return [parseAnswer({ interactionId: requestId })];
}

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
): JsonObject {
  return {
    statusCode: input.statusCode ?? 200,
    type: "application/vnd.microsoft.activity.message",
    value: input.message ?? "Answer received.",
  };
}

function renderInputs(request: Interaction): readonly Record<string, unknown>[] {
  if (
    request.request.display === "select" &&
    request.request.options &&
    request.request.options.length > 0
  ) {
    const { initialOptionId, options } = request.request;
    const choiceSet: Record<string, unknown> = {
      choices: options.map((option) => ({
        title: truncate(option.label, TEAMS_ADAPTIVE_CARD_CHOICE_TITLE_MAX_LENGTH),
        value: option.id,
      })),
      id: TEAMS_HITL_CHOICE_INPUT_ID,
      isMultiSelect: false,
      style: "compact",
      type: "Input.ChoiceSet",
    };
    if (options.some((option) => option.id === initialOptionId)) choiceSet.value = initialOptionId;
    return [choiceSet];
  }

  if (
    request.request.allowFreeform === true ||
    !request.request.options ||
    request.request.options.length === 0
  ) {
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
  request: Interaction,
  replyToActivityId: string | undefined,
): readonly Record<string, unknown>[] {
  const payload = (optionId?: string): Record<string, unknown> => {
    const value: Record<string, unknown> = {
      requestId: request.interactionId,
      [TEAMS_HITL_PROMPT_KEY]: truncate(
        request.request.prompt,
        TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH,
      ),
    };
    if (request.request.kind === "approval") value[TEAMS_HITL_REQUEST_KIND_KEY] = "tool-approval";
    if (replyToActivityId !== undefined) value.replyToActivityId = replyToActivityId;
    if (optionId !== undefined) value.optionId = optionId;
    return value;
  };
  const options = request.request.options;
  if (options && options.length > 0 && request.request.display !== "select") {
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

function formatApprovalInput(request: Interaction): string | null {
  if (request.request.kind !== "approval") {
    return null;
  }
  const json = JSON.stringify(request.call?.input ?? {}, null, 2);
  return json === "{}" ? null : json;
}
