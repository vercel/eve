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
 * Block Kit `card` blocks cap `body.text` at 200 chars.
 */
export const SLACK_CARD_BODY_TEXT_MAX_LENGTH = 200;

/**
 * Block Kit `card` blocks cap `subtext.text` at 200 chars.
 */
export const SLACK_CARD_SUBTEXT_MAX_LENGTH = 200;

/**
 * Top-level `text` field on `chat.postMessage` is capped at 40000 chars.
 */
export const SLACK_MESSAGE_TEXT_MAX_LENGTH = 40000;

/** Slack caps the `markdown_text` field at 12000 characters. */
export const SLACK_MARKDOWN_TEXT_MAX_LENGTH = 12000;

/**
 * Slack recommends keeping messages to 4000 characters for reliable,
 * readable delivery. Longer completed replies are split at this boundary.
 */
export const SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH = 4000;

/**
 * `chat.postMessage` rejects payloads with more than 50 blocks
 * (`invalid_blocks`).
 */
export const SLACK_MAX_BLOCKS_PER_MESSAGE = 50;

/**
 * `views.open` modal title is capped at 24 characters.
 */
export const SLACK_MODAL_TITLE_MAX_LENGTH = 24;

/**
 * Normalizes a typing status: strips lightweight Markdown that Slack
 * assistant-thread status does not render, trims, collapses runs of
 * whitespace into a single space, then truncates to
 * {@link SLACK_TYPING_STATUS_MAX_LENGTH} with a trailing ellipsis when
 * needed.
 */
export function truncateTypingStatus(status: string): string {
  const normalized = stripTypingStatusMarkdown(status).trim().replace(/\s+/gu, " ");
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
 * Caps a card block's `body.text` at the Slack limit with a trailing
 * ellipsis.
 */
export function truncateCardBodyText(value: string): string {
  return truncateWithEllipsis(value, SLACK_CARD_BODY_TEXT_MAX_LENGTH);
}

/**
 * Caps a card block's `subtext.text` at the Slack limit with a trailing
 * ellipsis.
 */
export function truncateCardSubtext(value: string): string {
  return truncateWithEllipsis(value, SLACK_CARD_SUBTEXT_MAX_LENGTH);
}

/**
 * Caps a `chat.postMessage` `text` field at the Slack limit with a
 * trailing ellipsis.
 */
export function truncateMessageText(value: string): string {
  return truncateWithEllipsis(value, SLACK_MESSAGE_TEXT_MAX_LENGTH);
}

/**
 * Splits a completed reply without dropping content. Paragraph boundaries
 * win over line boundaries; content with neither is cut at the limit.
 */
export function chunkMessageText(value: string): string[] {
  if (value.length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH) {
    const paragraphBoundary = remaining.lastIndexOf(
      "\n\n",
      SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH - 2,
    );
    const lineBoundary = remaining.lastIndexOf("\n", SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH - 1);
    let end =
      paragraphBoundary > 0 && remaining.slice(0, paragraphBoundary).trim().length > 0
        ? paragraphBoundary + 2
        : lineBoundary > 0 && remaining.slice(0, lineBoundary).trim().length > 0
          ? lineBoundary + 1
          : SLACK_MESSAGE_TEXT_RECOMMENDED_LENGTH;

    // Avoid cutting between the UTF-16 surrogate pair of an emoji or other
    // supplementary character when no natural text boundary is available.
    const precedingCodeUnit = remaining.charCodeAt(end - 1);
    const followingCodeUnit = remaining.charCodeAt(end);
    if (
      precedingCodeUnit >= 0xd800 &&
      precedingCodeUnit <= 0xdbff &&
      followingCodeUnit >= 0xdc00 &&
      followingCodeUnit <= 0xdfff
    ) {
      end -= 1;
    }

    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
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

function stripTypingStatusMarkdown(status: string): string {
  return status
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/(^|[^\p{L}\p{N}])(\*\*|__)([^*_]+)\2(?=$|[^\p{L}\p{N}])/gu, "$1$3")
    .replace(/(^|[^\p{L}\p{N}*])\*([^*_]+)\*(?=$|[^\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_([^*_]+)_(?=$|[^\p{L}\p{N}_])/gu, "$1$2");
}
