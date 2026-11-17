import { truncate as truncateWithEllipsis } from "#public/channels/text.js";

export const SLACK_TYPING_STATUS_MAX_LENGTH = 50;

export const SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH = 75;

export const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;

export const SLACK_CARD_BODY_TEXT_MAX_LENGTH = 200;

export const SLACK_CARD_SUBTEXT_MAX_LENGTH = 200;

export const SLACK_MESSAGE_TEXT_MAX_LENGTH = 40000;

export const SLACK_MARKDOWN_TEXT_MAX_LENGTH = 12000;

export const SLACK_MAX_BLOCKS_PER_MESSAGE = 50;

export const SLACK_CONTAINER_TITLE_MAX_LENGTH = 150;

export const SLACK_MODAL_TITLE_MAX_LENGTH = 24;

export function truncateTypingStatus(status: string): string {
  const normalized = stripTypingStatusMarkdown(status).trim().replace(/\s+/gu, " ");
  if (normalized.length <= SLACK_TYPING_STATUS_MAX_LENGTH) return normalized;
  const cut = normalized.slice(0, SLACK_TYPING_STATUS_MAX_LENGTH - 3);
  const space = cut.lastIndexOf(" ");
  const words = space > SLACK_TYPING_STATUS_MAX_LENGTH / 2 ? cut.slice(0, space) : cut;
  return `${words.trimEnd()}...`;
}

export function truncatePlainText(value: string): string;
export function truncatePlainText(value: string | undefined): string | undefined;
export function truncatePlainText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return truncateWithEllipsis(value, SLACK_BLOCK_KIT_PLAIN_TEXT_MAX_LENGTH);
}

export function truncateSectionText(value: string): string {
  return truncateWithEllipsis(value, SLACK_SECTION_TEXT_MAX_LENGTH);
}

export function truncateCardBodyText(value: string): string {
  return truncateWithEllipsis(value, SLACK_CARD_BODY_TEXT_MAX_LENGTH);
}

export function truncateCardSubtext(value: string): string {
  return truncateWithEllipsis(value, SLACK_CARD_SUBTEXT_MAX_LENGTH);
}

export function truncateMessageText(value: string): string {
  return truncateWithEllipsis(value, SLACK_MESSAGE_TEXT_MAX_LENGTH);
}

export function truncateContainerTitle(value: string): string {
  return truncateWithEllipsis(value, SLACK_CONTAINER_TITLE_MAX_LENGTH);
}

export function truncateModalTitle(value: string): string {
  return truncateWithEllipsis(value, SLACK_MODAL_TITLE_MAX_LENGTH);
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
