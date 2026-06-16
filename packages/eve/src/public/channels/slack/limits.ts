/**
 * Slack API string-length guards.
 *
 * Slack rejects payloads where a string exceeds its surface-specific
 * limit (typing indicator, Block Kit `plain_text` fields, modal titles,
 * etc.). The chat SDK does not enforce these for us — anything that
 * overruns surfaces as a `chat.postMessage` / `assistant.threads.setStatus`
 * / `views.open` HTTP error. These helpers cap strings before they cross
 * the wire so a single long tool name or option label cannot fail the
 * whole event handler.
 */

/**
 * Typing indicator (`assistant.threads.setStatus`) caps at roughly 100
 * characters; we use 50 to match the pre-existing UX (statuses longer
 * than a glance are hard to read in the chat UI anyway).
 */
export const SLACK_TYPING_STATUS_MAX_LENGTH = 50;

/**
 * Block Kit `plain_text` fields used in `static_select` / `radio_buttons`
 * options and button labels are capped at 75 characters by Slack.
 */
export const SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH = 75;

/**
 * Block Kit `section` blocks cap `text.text` at 3000 chars. Anything
 * longer fails the whole post with `invalid_blocks`.
 */
export const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;

/**
 * Top-level `text` field on `chat.postMessage` is capped at 40000 chars.
 */
export const SLACK_MESSAGE_TEXT_MAX_LENGTH = 40000;

/**
 * `views.open` modal title is capped at 24 characters.
 */
export const SLACK_MODAL_TITLE_MAX_LENGTH = 24;

/**
 * Normalizes a typing status: trims, collapses runs of whitespace into a
 * single space, then truncates to {@link SLACK_TYPING_STATUS_MAX_LENGTH}
 * with a trailing ellipsis when needed.
 */
export function truncateTypingStatus(status: string): string {
  const normalized = status.trim().replace(/\s+/gu, " ");
  return truncateWithEllipsis(normalized, SLACK_TYPING_STATUS_MAX_LENGTH);
}

/**
 * Caps a Block Kit `plain_text` label/description at the Slack limit
 * with a trailing ellipsis. Pass `undefined` to short-circuit (option
 * descriptions are optional).
 */
export function truncatePlainText(value: string): string;
export function truncatePlainText(value: string | undefined): string | undefined;
export function truncatePlainText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return truncateWithEllipsis(value, SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH);
}

/**
 * Caps a section block's `text.text` at the Slack limit with a
 * trailing ellipsis.
 */
export function truncateSectionText(value: string): string {
  return truncateWithEllipsis(value, SLACK_SECTION_TEXT_MAX_LENGTH);
}

/**
 * Caps a `chat.postMessage` `text` field at the Slack limit with a
 * trailing ellipsis.
 */
export function truncateMessageText(value: string): string {
  return truncateWithEllipsis(value, SLACK_MESSAGE_TEXT_MAX_LENGTH);
}

/**
 * Caps a modal title at the Slack limit with a trailing ellipsis.
 */
export function truncateModalTitle(value: string): string {
  return truncateWithEllipsis(value, SLACK_MODAL_TITLE_MAX_LENGTH);
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}
