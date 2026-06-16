/**
 * Slack HITL widget rendering + click-decode helpers.
 *
 * Wire format: select-style HITL widgets mint `action_id =
 * HITL_ACTION_PREFIX + requestId`. Button widgets add a stable suffix so
 * every button in the same Slack actions block has a unique `action_id`.
 * The decoder requires that suffix for button payloads.
 *
 * Buttons surface the selected option on `action.value`; radio and
 * static selects surface it on `selected_option.value`. The decoder
 * picks whichever is set so the renderer can pick a widget kind on
 * UX grounds without changing the read path.
 */

import {
  truncateModalTitle,
  truncatePlainText,
  truncateSectionText,
} from "#public/channels/slack/limits.js";
import type { InputRequest } from "#runtime/input/types.js";

/**
 * Wire-format prefix every framework HITL widget mints onto its
 * `action_id`. Exposed so end-user adapters that render their own
 * interactive widgets can avoid collisions.
 */
export const HITL_ACTION_PREFIX = "eve_input:";

/**
 * `action_id` prefix for the "Type your answer" button that opens a
 * freeform-answer modal. Splitting the prefix from {@link HITL_ACTION_PREFIX}
 * lets the route handler differentiate "this click is a final answer"
 * (resolve via `inputResponses`) from "this click needs a modal first"
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

/**
 * Maximum radio-button option count before the renderer falls back to
 * a `static_select` dropdown. Matches Slack's UX guidance (radio
 * groups stay readable up to ~6 items).
 */
const RADIO_SELECT_OPTION_LIMIT = 6;
const BUTTON_ACTION_ID_RE = /^(?<requestId>.+):button:\d+$/u;

/**
 * Subset of one Slack interactivity action the HITL decoder reads.
 * Mirrors the relevant fields of `SlackInteractionAction`.
 */
interface SlackHitlAction {
  readonly actionId: string;
  /** `value` field on Slack `button` payloads. */
  readonly value?: string;
  /** `selected_option.value` field on radio / static-select payloads. */
  readonly selectedOptionValue?: string;
}

/**
 * Resolved HITL response derived from one Slack interactivity action.
 * Matches the `InputResponse` contract minus `text` — freeform answers
 * come back through a different interaction path.
 */
interface DerivedHitlResponse {
  readonly requestId: string;
  readonly optionId: string;
}

/**
 * Decodes one Slack interactivity action into an HITL response, or
 * returns `null` when the action does not match an HITL widget the
 * framework rendered.
 */
export function deriveHitlResponse(action: SlackHitlAction): DerivedHitlResponse | null {
  if (!action.actionId.startsWith(HITL_ACTION_PREFIX)) return null;

  const encodedRequestId = action.actionId.slice(HITL_ACTION_PREFIX.length);

  if (action.selectedOptionValue !== undefined) {
    return encodedRequestId
      ? { optionId: action.selectedOptionValue, requestId: encodedRequestId }
      : null;
  }

  if (action.value !== undefined) {
    const requestId = BUTTON_ACTION_ID_RE.exec(encodedRequestId)?.groups?.requestId;
    return requestId ? { optionId: action.value, requestId } : null;
  }

  return null;
}

/**
 * Returns `true` when the action id was minted by an HITL widget the
 * framework rendered. Used by the channel route to split inbound
 * clicks into the HITL path vs. the user-owned `onInteraction` path.
 */
export function isHitlAction(actionId: string): boolean {
  return actionId.startsWith(HITL_ACTION_PREFIX);
}

/**
 * Renders one `InputRequest` as Block Kit blocks:
 *
 * - `display === "select"` with ≤ {@link RADIO_SELECT_OPTION_LIMIT}
 *   options → `radio_buttons`. Single-click answer, options stay
 *   visible.
 * - `display === "select"` with more options → `static_select`
 *   dropdown so the picker stays scrollable.
 * - Anything else with options → buttons. Best for visually distinct
 *   choices (approve / deny / cancel).
 * - No options (or `allowFreeform: true`) → a single "Type your answer"
 *   button that opens a Slack modal with a plain_text_input. The modal
 *   submission comes back as a `view_submission` webhook the channel
 *   resolves into an {@link InputResponse} carrying `text`.
 *
 * Always emits at least the prompt section.
 */
export function renderInputRequestBlocks(request: InputRequest): unknown[] {
  const prompt = {
    text: { text: truncateSectionText(request.prompt), type: "mrkdwn" },
    type: "section",
  };
  const actionId = `${HITL_ACTION_PREFIX}${request.requestId}`;

  const options = request.options;
  const acceptsFreeform = request.allowFreeform === true || !options || options.length === 0;

  if (options && options.length > 0 && request.display === "select") {
    const widget =
      options.length <= RADIO_SELECT_OPTION_LIMIT
        ? { type: "radio_buttons", action_id: actionId, options: options.map(buildOption) }
        : {
            type: "static_select",
            action_id: actionId,
            options: options.map(buildOption),
            placeholder: { type: "plain_text", text: "Choose an option" },
          };
    return [prompt, { type: "actions", elements: [widget] }];
  }

  if (options && options.length > 0) {
    return [
      prompt,
      {
        type: "actions",
        elements: options.map((opt, index) => buildButton(opt, actionId, index)),
      },
    ];
  }

  if (acceptsFreeform) {
    return [
      prompt,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: `${HITL_FREEFORM_ACTION_PREFIX}${request.requestId}`,
            text: { type: "plain_text", text: "Type your answer" },
            style: "primary",
            value: request.requestId,
          },
        ],
      },
    ];
  }

  return [prompt];
}

/**
 * Metadata round-tripped on the freeform-answer modal's
 * `private_metadata` field. Threaded from the button click that opens
 * the modal to the `view_submission` that closes it so the route can
 * deliver the answer back to the right session.
 */
export interface HitlFreeformModalMetadata {
  readonly continuationToken: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly requestId: string;
}

/**
 * Builds the `views.open` payload for the freeform-answer modal. The
 * triggering `prompt` is preserved as a header section so the user can
 * re-read what they're answering inside the modal.
 *
 * Title is auto-truncated to the Slack modal-title limit.
 */
export function buildFreeformModalView(input: {
  readonly metadata: HitlFreeformModalMetadata;
  readonly prompt?: string;
}): Record<string, unknown> {
  const title = input.prompt ? truncateModalTitle(input.prompt) : "Your answer";
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

/**
 * Extracts the requestId from a freeform-answer button's `action_id`.
 */
export function freeformRequestIdFromActionId(actionId: string): string | undefined {
  if (!isFreeformAction(actionId)) return undefined;
  const slice = actionId.slice(HITL_FREEFORM_ACTION_PREFIX.length);
  return slice.length > 0 ? slice : undefined;
}

function buildButton(
  opt: NonNullable<InputRequest["options"]>[number],
  actionId: string,
  index: number,
): Record<string, unknown> {
  const button: Record<string, unknown> = {
    action_id: `${actionId}:button:${index}`,
    text: { text: truncatePlainText(opt.label), type: "plain_text" },
    type: "button",
    value: opt.id,
  };
  if (opt.style === "primary" || opt.style === "danger") {
    button.style = opt.style;
  }
  return button;
}

function buildOption(opt: NonNullable<InputRequest["options"]>[number]): Record<string, unknown> {
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

/**
 * Renders the "answered" replacement blocks for a previously-posted
 * HITL card. Preserves the original prompt block (so context stays
 * visible), appends a confirmation line naming the chosen answer, and
 * attributes the click to the user when their id is known.
 *
 * Slack's `chat.update` replaces every block in one shot, so the caller
 * passes the full list to `blocks` and the rendered fallback text to
 * `text`.
 */
export function buildAnsweredBlocks(input: {
  readonly promptBlock: unknown;
  readonly answerLabel: string;
  readonly userId?: string;
}): unknown[] {
  const blocks: unknown[] = [];
  if (input.promptBlock !== undefined && input.promptBlock !== null) {
    blocks.push(input.promptBlock);
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `:white_check_mark: *${input.answerLabel}*` },
  });
  if (input.userId && input.userId.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Answered by <@${input.userId}>` }],
    });
  }
  return blocks;
}
