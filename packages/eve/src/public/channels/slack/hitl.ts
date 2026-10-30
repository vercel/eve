/**
 * Slack HITL widget rendering + click-decode helpers.
 *
 * Wire format: select-style HITL widgets mint `action_id =
 * ANSWER_ACTION_PREFIX + requestId`. Button widgets add a stable suffix so
 * every button in the same Slack actions block has a unique `action_id`.
 * The decoder requires that suffix for button payloads.
 *
 * Buttons surface the selected option on `action.value`; radio and
 * static selects surface it on `selected_option.value`. The decoder
 * picks whichever is set so the renderer can pick a widget kind on
 * UX grounds without changing the read path.
 */

import {
  truncateCardBodyText,
  SLACK_SECTION_TEXT_MAX_LENGTH,
  truncateModalTitle,
  truncatePlainText,
  truncateSectionText,
} from "#public/channels/slack/limits.js";
import { escapeSlackText, unescapeSlackText } from "#compiled/@chat-adapter/slack/format.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type { SlackInteractionCardParts } from "#public/channels/slack/renderers.js";
import { type Answer, parseAnswer, type ValidatedAnswer } from "#shared/input.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import { truncate as truncateWithEllipsis } from "#public/channels/text.js";
import type { SlackSessionTarget } from "#public/channels/slack/slackChannel.js";

/**
 * Wire-format prefix every framework HITL widget mints onto its
 * `action_id`. Exposed so end-user adapters that render their own
 * interactive widgets can avoid collisions.
 */
export const ANSWER_ACTION_PREFIX = "eve_input:";

/**
 * `action_id` prefix for the "Type your answer" button that opens a
 * freeform-answer modal. Splitting the prefix from {@link ANSWER_ACTION_PREFIX}
 * lets the route handler differentiate "this click is a final answer"
 * (resolve via `answers`) from "this click needs a modal first"
 * (call `views.open`, then resolve on `view_submission`).
 */
export const HITL_FREEFORM_ACTION_PREFIX = "eve_input_freeform:";

/**
 * `view.callback_id` carried on the freeform-answer modal. Used to
 * route the inbound `view_submission` back to this channel.
 */
export const HITL_FREEFORM_MODAL_CALLBACK_ID = "eve_input_freeform_submit";

/**
 * `block_id` of the modal's text-input block — the route reads the
 * submitted text out of `view.state.values[block_id][action_id]`.
 */
export const HITL_FREEFORM_MODAL_BLOCK_ID = "eve_freeform_block";

/**
 * `action_id` of the text input inside the freeform answer modal.
 */
export const HITL_FREEFORM_MODAL_ACTION_ID = "eve_freeform_text";

const HITL_ROUTE_PREFIX = `${ANSWER_ACTION_PREFIX}route:`;
const HITL_CODE_CHANNEL_ROUTE_PREFIX = `${ANSWER_ACTION_PREFIX}code:`;

/** Slack session a routed HITL widget answers back to. */
export type SlackHitlRoute = SlackSessionTarget;

/**
 * Maximum radio-button option count before the renderer falls back to
 * a `static_select` dropdown. Matches Slack's UX guidance (radio
 * groups stay readable up to ~6 items).
 */
const RADIO_SELECT_OPTION_LIMIT = 6;
const BUTTON_ACTION_ID_RE = /^(?:(?<kind>tool-approval):)?(?<requestId>.+):button:\d+$/u;
const TOOL_INPUT_PREFIX = "*Tool input*\n```\n";
const TOOL_INPUT_CODE_PREFIX = "```\n";
const TOOL_INPUT_SUFFIX = "\n```";
const ANSWERED_TEXT_PREFIX = ":white_check_mark: *";
const ANSWERED_TEXT_SUFFIX = "*";

type SlackInteractionOption = NonNullable<Interaction["request"]["options"]>[number];
type CardButtonOption = Pick<SlackInteractionOption, "id" | "label" | "style">;

/**
 * Subset of one Slack interactivity action the HITL decoder reads.
 * Mirrors the relevant fields of `SlackInteractionAction`.
 */
export interface SlackHitlAction {
  readonly actionId: string;
  /** `value` field on Slack `button` payloads. */
  readonly value?: string;
  /** `selected_option.value` field on radio / static-select payloads. */
  readonly selectedOptionValue?: string;
}

/**
 * Resolved HITL response derived from one Slack interactivity action.
 * Slack-local classification stays beside the eve input response so
 * presentation metadata cannot cross the durable session-inbox boundary.
 */
export interface DerivedHitlResponse {
  readonly kind?: "tool-approval";
  readonly response: Answer;
  readonly route?: SlackHitlRoute;
}

/** A derived response whose input response already passed schema validation. */
interface ValidatedHitlResponse extends DerivedHitlResponse {
  readonly response: ValidatedAnswer;
}

interface DecodedHitlActionId {
  button: boolean;
  kind?: "tool-approval";
  requestId: string;
  route?: SlackHitlRoute;
}

/**
 * Decodes one Slack interactivity action on a widget from
 * {@link renderInteractionBlocks} into an HITL response, or returns `null`
 * when the action does not match an HITL widget eve rendered.
 */
export const answerFromSlackAction: (action: SlackHitlAction) => DerivedHitlResponse | null = (
  action,
) => decodeHitlResponse(action);

/** {@link answerFromSlackAction}, keeping the validated type `respond()` accepts. */
export function decodeHitlResponse(action: SlackHitlAction): ValidatedHitlResponse | null {
  const decoded = decodeHitlActionId(action.actionId);
  if (decoded === null) return null;
  const optionId = action.selectedOptionValue ?? action.value;
  if (optionId === undefined || (action.value !== undefined && !decoded.button)) return null;
  const derived: {
    kind?: "tool-approval";
    response: ValidatedAnswer;
    route?: SlackHitlRoute;
  } = { response: parseAnswer({ interactionId: decoded.requestId, optionId }) };
  if (decoded.kind !== undefined) derived.kind = decoded.kind;
  if (decoded.route !== undefined) derived.route = decoded.route;
  return derived;
}

function splitEncodedRequest(value: string): {
  readonly kind?: "tool-approval";
  readonly requestId: string;
} {
  const prefix = "tool-approval:";
  return value.startsWith(prefix)
    ? { kind: "tool-approval", requestId: value.slice(prefix.length) }
    : { requestId: value };
}

/**
 * Returns `true` when the action id was minted by an HITL widget the
 * framework rendered. Used by the channel route to split inbound
 * clicks into the HITL path vs. the user-owned `onInteraction` path.
 */
export function isHitlAction(actionId: string): boolean {
  return actionId.startsWith(ANSWER_ACTION_PREFIX);
}

/** Decodes the framework-owned identity and optional return route from one action id. */
export function decodeHitlActionId(actionId: string): DecodedHitlActionId | null {
  if (!actionId.startsWith(ANSWER_ACTION_PREFIX)) return null;
  let encoded = actionId.slice(ANSWER_ACTION_PREFIX.length);
  let route: SlackHitlRoute | undefined;
  if (encoded.startsWith("route:")) {
    encoded = encoded.slice("route:".length);
    const first = encoded.indexOf(":");
    const second = encoded.indexOf(":", first + 1);
    if (first <= 0 || second <= first + 1) return null;
    route = { channelId: encoded.slice(0, first), threadTs: encoded.slice(first + 1, second) };
    encoded = encoded.slice(second + 1);
  } else if (encoded.startsWith("code:")) {
    encoded = encoded.slice("code:".length);
    const end = encoded.indexOf(":");
    if (end <= 0) return null;
    route = { channelId: encoded.slice(0, end), codeChannel: true };
    encoded = encoded.slice(end + 1);
  }
  const button = BUTTON_ACTION_ID_RE.exec(encoded);
  const request = splitEncodedRequest(button?.groups?.requestId ?? encoded);
  if (!request.requestId) return null;
  const kind = button?.groups?.kind === "tool-approval" ? "tool-approval" : request.kind;
  const decoded: DecodedHitlActionId = {
    button: button !== null,
    requestId: request.requestId,
  };
  if (kind !== undefined) decoded.kind = kind;
  if (route !== undefined) decoded.route = route;
  return decoded;
}

function encodeHitlActionId(request: Interaction, route?: SlackHitlRoute): string {
  const requestIdentity = `${request.request.kind === "approval" ? "tool-approval:" : ""}${request.interactionId}`;
  if (route === undefined) return `${ANSWER_ACTION_PREFIX}${requestIdentity}`;
  return route.codeChannel === true
    ? `${HITL_CODE_CHANNEL_ROUTE_PREFIX}${route.channelId}:${requestIdentity}`
    : `${HITL_ROUTE_PREFIX}${route.channelId}:${route.threadTs}:${requestIdentity}`;
}

/**
 * Renders one `Interaction` as Block Kit blocks. Clicks on the rendered
 * widgets decode with {@link answerFromSlackAction}:
 *
 * - `display === "select"` with ≤ {@link RADIO_SELECT_OPTION_LIMIT}
 *   options → `radio_buttons`. Single-click answer, options stay
 *   visible.
 * - `display === "select"` with more options → `static_select`
 *   dropdown so the picker stays scrollable.
 * - Anything else with options → Slack `card` blocks with action
 *   buttons. Best for visually distinct choices (allow / cancel /
 *   cancel).
 * - No options (or `allowFreeform: true`) → a single "Type your answer"
 *   button that opens a Slack modal with a plain_text_input. The modal
 *   submission comes back as a `view_submission` webhook the channel
 *   resolves into an {@link Answer} carrying `text`.
 *
 * Always emits at least the prompt section.
 */
export function renderInteractionBlocks(
  request: Interaction,
  route?: SlackHitlRoute,
): BlockKitBlock[] {
  const prompt = {
    text: { text: truncateSectionText(escapeSlackText(request.request.prompt)), type: "mrkdwn" },
    type: "section",
  };
  const details = renderInteractionDetailBlocks(request);
  const actionId = encodeHitlActionId(request, route);

  const options = request.request.options;
  const acceptsFreeform =
    request.request.allowFreeform === true || !options || options.length === 0;

  if (options && options.length > 0 && request.request.display === "select") {
    const widget =
      options.length <= RADIO_SELECT_OPTION_LIMIT
        ? { type: "radio_buttons", action_id: actionId, options: options.map(buildOption) }
        : {
            type: "static_select",
            action_id: actionId,
            options: options.map(buildOption),
            placeholder: { type: "plain_text", text: "Choose an option" },
          };
    return [prompt, ...details, { type: "actions", elements: [widget] }];
  }

  if (options && options.length > 0) {
    const card = renderInteractionCardBlock(request, actionId);
    const details = renderToolInputContainerBlock(request);
    return details === undefined ? [card] : [card, details];
  }

  if (acceptsFreeform) {
    const freeformActionId = actionId.replace(ANSWER_ACTION_PREFIX, HITL_FREEFORM_ACTION_PREFIX);
    return [
      prompt,
      ...details,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: freeformActionId,
            text: { type: "plain_text", text: "Type your answer" },
            style: "primary",
            value: request.interactionId,
          },
        ],
      },
    ];
  }

  return [prompt];
}

/**
 * Splits approval details from their interactive controls. Slack includes the
 * originating message in `block_actions`, so putting large tool input beside
 * the buttons makes the callback body grow with model-authored input.
 */
export function renderInteractionPostParts(
  request: Interaction,
  route?: SlackHitlRoute,
): SlackInteractionCardParts {
  const blocks = renderInteractionBlocks(request, route);
  const [firstBlock, ...details] = blocks;
  if (
    !isApprovalRequest(request) ||
    firstBlock === undefined ||
    !isBlockType(firstBlock, "card") ||
    details.length === 0
  ) {
    return {
      controls: { blocks, text: formatInteractionFallbackText(request) },
    };
  }

  return {
    controls: { blocks: [firstBlock], text: escapeSlackText(request.request.prompt) },
    details: { blocks: details, text: formatInteractionFallbackText(request) },
  };
}

/**
 * Creates the fallback text for one HITL request. Slack clients use this
 * outside the rich Block Kit surface, so include the same approval details
 * that appear in the blocks.
 */
export function formatInteractionFallbackText(request: Interaction): string {
  const prompt = escapeSlackText(request.request.prompt);
  const details = formatToolInputDetails(request);
  return details === undefined ? prompt : `${prompt}\n${details}`;
}

/**
 * Metadata round-tripped on the freeform-answer modal's
 * `private_metadata` field. Threaded from the button click that opens
 * the modal to the `view_submission` that closes it so the route can
 * deliver the answer back to the right session.
 */
export type HitlFreeformModalMetadata = SlackSessionTarget & {
  readonly continuationToken: string;
  /** Workspace whose app installation supplies credentials for modal follow-up API calls. */
  readonly installationTeamId?: string;
  /** Slack conversation containing the interactive card. */
  readonly messageChannelId?: string;
  readonly messageTs: string;
  readonly requestId: string;
};

/**
 * Builds the `views.open` payload for the freeform-answer modal. The
 * triggering `prompt` is preserved as a header section so the user can
 * re-read what they're answering inside the modal. `prompt` is the posted
 * card's mrkdwn, which was escaped when the card was rendered.
 *
 * Title is auto-truncated to the Slack modal-title limit.
 */
export function buildFreeformModalView(input: {
  readonly metadata: HitlFreeformModalMetadata;
  readonly prompt?: string;
}): Record<string, unknown> {
  // The title is plain_text, which Slack shows without decoding `&amp;`.
  const title = input.prompt ? truncateModalTitle(unescapeSlackText(input.prompt)) : "Your answer";
  const promptBlocks = input.prompt
    ? [{ type: "section", text: { type: "mrkdwn", text: truncateSectionText(input.prompt) } }]
    : [];
  return {
    type: "modal",
    callback_id: HITL_FREEFORM_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(input.metadata),
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      ...promptBlocks,
      {
        type: "input",
        block_id: HITL_FREEFORM_MODAL_BLOCK_ID,
        element: {
          type: "plain_text_input",
          action_id: HITL_FREEFORM_MODAL_ACTION_ID,
          multiline: true,
          placeholder: { type: "plain_text", text: "Type your answer here..." },
        },
        label: { type: "plain_text", text: "Answer" },
      },
    ],
  };
}

/**
 * True when an `action_id` was minted by the framework's freeform-answer
 * button (the click that opens a modal — not the final answer).
 */
export function isFreeformAction(actionId: string): boolean {
  return actionId.startsWith(HITL_FREEFORM_ACTION_PREFIX);
}

export function decodeFreeformHitlActionId(actionId: string): DecodedHitlActionId | null {
  if (!isFreeformAction(actionId)) return null;
  return decodeHitlActionId(
    `${ANSWER_ACTION_PREFIX}${actionId.slice(HITL_FREEFORM_ACTION_PREFIX.length)}`,
  );
}

function buildCardButton(
  opt: CardButtonOption,
  actionId: string,
  index: number,
): Record<string, unknown> {
  const button: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text: truncatePlainText(opt.label), emoji: false },
    action_id: `${actionId}:button:${index}`,
    value: opt.id,
  };
  if (opt.style === "primary" || opt.style === "danger") {
    button.style = opt.style;
  }
  return button;
}

function buildOption(opt: SlackInteractionOption): Record<string, unknown> {
  const option: Record<string, unknown> = {
    text: { text: truncatePlainText(opt.label), type: "plain_text" },
    value: opt.id,
  };
  const description = truncatePlainText(opt.description);
  if (description && description.length > 0) {
    option.description = { text: description, type: "plain_text" };
  }
  return option;
}

function renderInteractionCardBlock(
  request: Interaction,
  actionId: string,
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    type: "card",
    body: {
      type: "mrkdwn",
      text: truncateCardBodyText(`*${escapeSlackText(request.request.prompt)}*`),
      verbatim: false,
    },
    actions: cardButtonOptions(request).map((opt, index) => buildCardButton(opt, actionId, index)),
  };
  // A tool approval holds the turn until someone acts, so say so on the card.
  if (isApprovalRequest(request)) {
    card.subtext = { type: "mrkdwn", text: "I've paused until someone approves or denies." };
  }
  return card;
}

function cardButtonOptions(request: Interaction): CardButtonOption[] {
  const options = request.request.options ?? [];
  if (!isApprovalRequest(request)) return options.map(toCardButtonOption);

  const allow = options.find((option) => option.id === "approve");
  const deny = options.find((option) => option.id === "deny");
  if (!allow || !deny) return options.map(toCardButtonOption);

  return [
    { id: deny.id, label: "Deny" },
    { id: allow.id, label: "Approve", style: "primary" },
  ];
}

function toCardButtonOption(option: SlackInteractionOption): CardButtonOption {
  const result: CardButtonOption = { id: option.id, label: option.label };
  if (option.style === "primary" || option.style === "danger") {
    return { ...result, style: option.style };
  }
  return result;
}

/**
 * Renders the "answered" replacement blocks for a previously-posted
 * HITL card. Preserves the original prompt/detail blocks (so context
 * stays visible), appends a confirmation line naming the chosen answer,
 * and attributes the click to the user when their id is known.
 *
 * Slack's `chat.update` replaces every block in one shot, so the caller
 * passes the full list to `blocks` and the rendered fallback text to
 * `text`.
 */
export function buildAnsweredBlocks(input: {
  readonly promptBlocks: readonly unknown[];
  readonly answerLabel: string;
  readonly userId?: string;
}): unknown[] {
  const blocks: unknown[] = [];
  for (const promptBlock of input.promptBlocks) {
    if (promptBlock !== undefined && promptBlock !== null) {
      blocks.push(promptBlock);
    }
  }
  // Freeform answers echo user-typed text, which can exceed the section
  // limit on its own; cap the label so `chat.update` cannot fail.
  const answerLabel = truncateWithEllipsis(
    escapeSlackText(input.answerLabel),
    SLACK_SECTION_TEXT_MAX_LENGTH - ANSWERED_TEXT_PREFIX.length - ANSWERED_TEXT_SUFFIX.length,
  );
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `${ANSWERED_TEXT_PREFIX}${answerLabel}${ANSWERED_TEXT_SUFFIX}` },
  });
  if (input.userId && input.userId.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Answered by <@${input.userId}>` }],
    });
  }
  return blocks;
}

function renderInteractionDetailBlocks(request: Interaction): BlockKitBlock[] {
  const details = formatToolInputDetails(request);
  return details === undefined
    ? []
    : [{ type: "section", text: { type: "mrkdwn", text: details } }];
}

function renderToolInputContainerBlock(request: Interaction): Record<string, unknown> | undefined {
  const details = formatToolInputContainerText(request);
  if (details === undefined) return undefined;

  return {
    type: "container",
    title: { type: "plain_text", text: "Tool input" },
    is_collapsible: true,
    default_collapsed: true,
    child_blocks: [{ type: "section", text: { type: "mrkdwn", text: details } }],
  };
}

function formatToolInputContainerText(request: Interaction): string | undefined {
  if (!isApprovalRequest(request)) return undefined;

  const json = JSON.stringify(request.call?.input ?? {}, null, 2);
  if (json === "{}") return undefined;
  const escaped = escapeSlackText(json);

  const bodyBudget =
    SLACK_SECTION_TEXT_MAX_LENGTH - TOOL_INPUT_CODE_PREFIX.length - TOOL_INPUT_SUFFIX.length;
  const body = truncateWithEllipsis(escaped, bodyBudget);
  return `${TOOL_INPUT_CODE_PREFIX}${body}${TOOL_INPUT_SUFFIX}`;
}

function formatToolInputDetails(request: Interaction): string | undefined {
  if (!isApprovalRequest(request)) return undefined;

  const json = JSON.stringify(request.call?.input ?? {}, null, 2);
  if (json === "{}") return undefined;
  const escaped = escapeSlackText(json);

  const bodyBudget =
    SLACK_SECTION_TEXT_MAX_LENGTH - TOOL_INPUT_PREFIX.length - TOOL_INPUT_SUFFIX.length;
  const body = truncateWithEllipsis(escaped, bodyBudget);
  return `${TOOL_INPUT_PREFIX}${body}${TOOL_INPUT_SUFFIX}`;
}

function isBlockType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

function isApprovalRequest(request: Interaction): boolean {
  return request.request.kind === "approval";
}
