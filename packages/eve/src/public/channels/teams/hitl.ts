/** Teams Adaptive Card rendering and decode helpers for eve HITL prompts. */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  normalizeTeamsContinuationAddress,
  TEAMS_MESSAGE_TEXT_MAX_LENGTH,
  type TeamsAttachment,
  type TeamsMessageBody,
} from "#public/channels/teams/api.js";
import type {
  TeamsActivity,
  TeamsInvokeActivity,
  TeamsMessageActivity,
} from "#public/channels/teams/inbound.js";
import {
  TEAMS_ADAPTIVE_CARD_ACTION_LIMIT,
  TEAMS_ADAPTIVE_CARD_ACTION_TITLE_MAX_LENGTH,
  TEAMS_ADAPTIVE_CARD_CHOICE_TITLE_MAX_LENGTH,
  TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH,
} from "#public/channels/teams/limits.js";
import {
  formatApprovalInput,
  type InputRequest,
  type InputResponse,
} from "#runtime/input/types.js";
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

const TEAMS_HITL_INVOKE_NAME = "adaptiveCard/action";
const TEAMS_HITL_ROUTE_KEY = "route";
const TEAMS_HITL_ROUTE_VERSION = "v1";
const TEAMS_ADAPTIVE_CARD_MAX_BYTES = 28 * 1024;
const ELLIPSIS = "...";

interface TeamsHitlRoute {
  readonly continuationToken: string;
  readonly signature: string;
}

interface TeamsInputRequestRenderOptions {
  readonly adaptiveCardVersion?: string;
  readonly continuationToken: string;
  readonly conversationId: string;
  readonly secret: string;
  readonly tenantId: string;
}

export type TeamsHitlSubmissionParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | {
      readonly continuationToken: string;
      readonly kind: "valid";
      readonly response: InputResponse;
    };

/**
 * Parses and verifies an eve HITL submission once at the Teams webhook boundary.
 * Unsigned legacy cards are invalid because invoke activities cannot reliably
 * recover the thread that originally parked the session.
 */
export async function parseTeamsHitlSubmission(
  activity: TeamsMessageActivity | TeamsInvokeActivity,
  resolveSecret: () => string | Promise<string>,
): Promise<TeamsHitlSubmissionParseResult> {
  if (activity.type === "invoke" && activity.name !== TEAMS_HITL_INVOKE_NAME) {
    return { kind: "none" };
  }

  const value = readActivityValue(activity);
  if (!value) return { kind: "none" };
  const payload = readHitlPayload(value);
  if (!payload) return { kind: "none" };

  const response = deriveInputResponse(value, payload);
  if (!response || !activity.tenantId) return { kind: "invalid" };
  const route = readHitlRoute(payload);
  if (!route) return { kind: "invalid" };
  if (!routeMatchesActivityThread(route.continuationToken, activity)) {
    return { kind: "invalid" };
  }

  const expected = signTeamsHitlRoute({
    continuationToken: route.continuationToken,
    conversationId: activity.conversation.id,
    requestId: response.requestId,
    secret: await resolveSecret(),
    tenantId: activity.tenantId,
  });
  if (!constantTimeEqual(route.signature, expected)) return { kind: "invalid" };

  return {
    continuationToken: route.continuationToken,
    kind: "valid",
    response,
  };
}

/** Renders one input request as a Teams message body containing an Adaptive Card. */
export function renderInputRequestMessage(
  request: InputRequest,
  options: TeamsInputRequestRenderOptions,
): TeamsMessageBody {
  const toolInput = formatApprovalInput(request);
  const fallback = toolInput ? `${request.prompt}\n\nTool input:\n${toolInput}` : request.prompt;
  const route = createTeamsHitlRoute(request, options);
  return {
    attachments: [renderInputRequestAttachmentWithDetails(request, options, route, toolInput)],
    text: truncateUtf8(fallback, TEAMS_MESSAGE_TEXT_MAX_LENGTH),
  };
}

/**
 * Renders one input request as a Teams Adaptive Card attachment.
 * `options.adaptiveCardVersion` sets the card schema version (default "1.5").
 */
export function renderInputRequestAttachment(
  request: InputRequest,
  options: TeamsInputRequestRenderOptions,
): TeamsAttachment {
  return renderInputRequestAttachmentWithDetails(
    request,
    options,
    createTeamsHitlRoute(request, options),
    formatApprovalInput(request),
  );
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

/** Decodes an eve HITL response without verifying its signed route envelope. */
export function deriveTeamsInputResponses(activity: TeamsActivity): readonly InputResponse[] {
  const value = readActivityValue(activity);
  if (!value) return [];
  const payload = readHitlPayload(value);
  if (!payload) return [];
  const response = deriveInputResponse(value, payload);
  return response ? [response] : [];
}

/** Builds the HTTP body Teams expects after an Adaptive Card invoke action. */
export function teamsInvokeResponse(
  input: { readonly message?: string; readonly statusCode?: number } = {},
): Record<string, unknown> {
  return {
    statusCode: input.statusCode ?? 200,
    type: "application/vnd.microsoft.activity.message",
    value: input.message ?? "Answer received.",
  };
}

function renderInputRequestAttachmentWithDetails(
  request: InputRequest,
  options: TeamsInputRequestRenderOptions,
  route: TeamsHitlRoute,
  toolInput: string | undefined,
): TeamsAttachment {
  const prompt = truncate(request.prompt, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH);
  const details = toolInput ? truncate(toolInput, TEAMS_ADAPTIVE_CARD_TEXT_MAX_LENGTH) : undefined;
  const card = fitCardToByteLimit(request, options, route, prompt, details);
  return {
    content: parseJsonObject(card),
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  };
}

function fitCardToByteLimit(
  request: InputRequest,
  options: TeamsInputRequestRenderOptions,
  route: TeamsHitlRoute,
  prompt: string,
  details: string | undefined,
): Record<string, unknown> {
  const build = (promptText: string, detailText: string | undefined) => ({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    actions: renderActions(request, route),
    body: [
      { text: promptText, type: "TextBlock", wrap: true },
      ...(detailText
        ? [{ fontType: "Monospace", text: detailText, type: "TextBlock", wrap: true }]
        : []),
      ...renderInputs(request),
    ],
    type: "AdaptiveCard",
    version: options.adaptiveCardVersion ?? "1.5",
  });

  let card = build(prompt, details);
  if (jsonByteLength(card) <= TEAMS_ADAPTIVE_CARD_MAX_BYTES) return card;

  if (details) {
    const fitted = maximizeUtf8(
      details,
      (candidate) =>
        jsonByteLength(build(prompt, candidate || undefined)) <= TEAMS_ADAPTIVE_CARD_MAX_BYTES,
    );
    card = build(prompt, fitted || undefined);
    if (jsonByteLength(card) <= TEAMS_ADAPTIVE_CARD_MAX_BYTES) return card;
  }

  const fittedPrompt = maximizeUtf8(
    prompt,
    (candidate) => jsonByteLength(build(candidate, undefined)) <= TEAMS_ADAPTIVE_CARD_MAX_BYTES,
  );
  card = build(fittedPrompt, undefined);
  if (jsonByteLength(card) > TEAMS_ADAPTIVE_CARD_MAX_BYTES) {
    throw new Error("teamsChannel: HITL Adaptive Card metadata exceeds the Teams size limit.");
  }
  return card;
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
  route: TeamsHitlRoute,
): readonly Record<string, unknown>[] {
  const data = (optionId?: string) => {
    const payload: Record<string, unknown> = { requestId: request.requestId };
    if (optionId !== undefined) payload.optionId = optionId;
    payload[TEAMS_HITL_ROUTE_KEY] = route;
    return { [TEAMS_HITL_DATA_KEY]: payload };
  };
  const options = request.options;
  if (options && options.length > 0 && request.display !== "select") {
    return options.slice(0, TEAMS_ADAPTIVE_CARD_ACTION_LIMIT).map((option) => ({
      data: data(option.id),
      title: truncate(option.label, TEAMS_ADAPTIVE_CARD_ACTION_TITLE_MAX_LENGTH),
      type: "Action.Submit",
    }));
  }

  return [{ data: data(), title: "Submit", type: "Action.Submit" }];
}

function deriveInputResponse(
  value: Record<string, unknown>,
  payload: Record<string, unknown>,
): InputResponse | null {
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return null;

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

  if (optionId !== undefined) return { optionId, requestId };
  if (text !== undefined) return { requestId, text };
  return { requestId };
}

function readActivityValue(activity: TeamsActivity): Record<string, unknown> | null {
  if (activity.type === "message") return activity.value ?? null;
  if (activity.type !== "invoke") return null;
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

function readHitlRoute(payload: Record<string, unknown>): TeamsHitlRoute | null {
  const route = payload[TEAMS_HITL_ROUTE_KEY];
  if (!isObject(route)) return null;
  if (typeof route.continuationToken !== "string" || typeof route.signature !== "string") {
    return null;
  }
  return { continuationToken: route.continuationToken, signature: route.signature };
}

function createTeamsHitlRoute(
  request: InputRequest,
  options: TeamsInputRequestRenderOptions,
): TeamsHitlRoute {
  if (options.secret.trim().length === 0) {
    throw new Error("teamsChannel: the HITL signing secret must not be empty.");
  }
  return {
    continuationToken: options.continuationToken,
    signature: signTeamsHitlRoute({
      continuationToken: options.continuationToken,
      conversationId: options.conversationId,
      requestId: request.requestId,
      secret: options.secret,
      tenantId: options.tenantId,
    }),
  };
}

function routeMatchesActivityThread(
  continuationToken: string,
  activity: TeamsMessageActivity | TeamsInvokeActivity,
): boolean {
  if (activity.scope === "personal") return true;
  const observedRoot = readConversationThreadRoot(activity.conversation.id) ?? activity.replyToId;
  if (!observedRoot) return true;
  const encodedRoot = continuationToken.slice(continuationToken.lastIndexOf(":") + 1);
  try {
    return decodeURIComponent(encodedRoot) === observedRoot;
  } catch {
    return false;
  }
}

function readConversationThreadRoot(conversationId: string): string | null {
  const marker = ";messageid=";
  const index = conversationId.lastIndexOf(marker);
  if (index < 0) return null;
  return conversationId.slice(index + marker.length) || null;
}

function signTeamsHitlRoute(input: {
  readonly continuationToken: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly secret: string;
  readonly tenantId: string;
}): string {
  const address = normalizeTeamsContinuationAddress({ conversationId: input.conversationId });
  const message = JSON.stringify([
    TEAMS_HITL_ROUTE_VERSION,
    input.tenantId,
    address.conversationId,
    input.requestId,
    input.continuationToken,
  ]);
  return createHmac("sha256", input.secret).update(message).digest("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function maximizeUtf8(value: string, fits: (candidate: string) => boolean): string {
  const bytes = new TextEncoder().encode(value);
  let low = 0;
  let high = bytes.byteLength;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(value, middle);
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const suffixBytes = new TextEncoder().encode(ELLIPSIS).byteLength;
  const bodyBytes = Math.max(0, maxBytes - suffixBytes);
  const body = new TextDecoder().decode(bytes.slice(0, bodyBytes)).replace(/\uFFFD$/u, "");
  return `${body.trimEnd()}${ELLIPSIS}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - ELLIPSIS.length);
  return `${value.slice(0, sliceLength).trimEnd()}${ELLIPSIS}`;
}
