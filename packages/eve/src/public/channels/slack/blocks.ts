/**
 * Card → Slack Block Kit converter.
 *
 * The chat SDK's Slack adapter used to walk the cross-platform
 * `CardElement` AST (the data shape produced by `Card({...})`,
 * `Actions([...])`, `Button({...})`, etc.) and emit Slack Block Kit
 * JSON for `chat.postMessage`. We replicate just that conversion here
 * so authors can keep using the ergonomic card builders without the
 * `@chat-adapter/slack` runtime.
 *
 * Supported shapes:
 *   Card                  → header + context + image header + children blocks
 *   TextElement           → `section`/`context` (style: plain | bold | muted)
 *   ImageElement          → `image` block
 *   DividerElement        → `divider`
 *   ActionsElement        → `actions` with buttons / link buttons /
 *                           static_select / radio_buttons
 *   SectionElement        → recurses into a sequence of blocks
 *   FieldsElement         → `section` with fields
 *   LinkElement           → `section` with a `<url|label>` mrkdwn
 *   TableElement          → `section` with a mrkdwn approximation
 *   ButtonElement         → `button` action element
 *   LinkButtonElement     → `button` action element with `url`
 *
 * Anything else falls back to the chat SDK's
 * `cardChildToFallbackText` (a string description) wrapped in a
 * section block so the message is never silently dropped.
 */

import {
  cardChildToFallbackText,
  type ActionsElement,
  type ButtonElement,
  type CardChild,
  type CardElement,
  type DividerElement,
  type FieldsElement,
  type ImageElement,
  type LinkButtonElement,
  type LinkElement,
  type RadioSelectElement,
  type SectionElement,
  type SelectElement,
  type TableElement,
  type TextElement,
} from "#compiled/chat/index.js";

import { truncatePlainText } from "#public/channels/slack/limits.js";

/**
 * One Slack Block Kit block. Slack accepts a wide enum and adds new
 * block types over time, so this type stays open-ended.
 */
export type BlockKitBlock = Record<string, unknown>;

interface CardToBlocksState {
  usedNativeTable: boolean;
}

/**
 * Converts a {@link CardElement} into a list of Slack Block Kit blocks
 * ready to pass to `chat.postMessage`'s `blocks` parameter.
 */
export function cardToBlocks(card: CardElement): BlockKitBlock[] {
  const blocks: BlockKitBlock[] = [];
  const state: CardToBlocksState = { usedNativeTable: false };

  if (card.title) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: truncatePlainText(card.title) ?? card.title, emoji: true },
    });
  }
  if (card.subtitle) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: card.subtitle }],
    });
  }
  if (card.imageUrl) {
    blocks.push({ type: "image", image_url: card.imageUrl, alt_text: card.title ?? "" });
  }
  for (const child of card.children) {
    appendChildBlocks(child, blocks, state);
  }
  return blocks;
}

/**
 * Best-effort fallback text for a card. `chat.postMessage` sends this
 * as the `text` field so notifications and accessibility readers still
 * see something meaningful.
 */
export function cardToFallbackText(card: CardElement): string {
  const lines: string[] = [];
  if (card.title) lines.push(card.title);
  if (card.subtitle) lines.push(card.subtitle);
  for (const child of card.children) {
    const text = cardChildToFallbackText(child);
    if (text && text.length > 0) lines.push(text);
  }
  return lines.join("\n").trim();
}

function appendChildBlocks(
  child: CardChild,
  blocks: BlockKitBlock[],
  state: CardToBlocksState,
): void {
  switch (child.type) {
    case "text":
      blocks.push(textToBlock(child));
      return;
    case "image":
      blocks.push(imageToBlock(child));
      return;
    case "divider":
      blocks.push(dividerToBlock(child));
      return;
    case "actions":
      blocks.push(actionsToBlock(child));
      return;
    case "section":
      for (const inner of (child as SectionElement).children) {
        appendChildBlocks(inner, blocks, state);
      }
      return;
    case "fields":
      blocks.push(fieldsToBlock(child));
      return;
    case "link":
      blocks.push(linkToBlock(child));
      return;
    case "table":
      blocks.push(...tableToBlocks(child, state));
      return;
    default: {
      const fallback = cardChildToFallbackText(child);
      if (fallback) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: fallback } });
      }
    }
  }
}

function textToBlock(text: TextElement): BlockKitBlock {
  if (text.style === "muted") {
    return {
      type: "context",
      elements: [{ type: "mrkdwn", text: text.content }],
    };
  }
  const body = text.style === "bold" ? `*${text.content}*` : text.content;
  return { type: "section", text: { type: "mrkdwn", text: body } };
}

function imageToBlock(image: ImageElement): BlockKitBlock {
  return { type: "image", image_url: image.url, alt_text: image.alt ?? "" };
}

function dividerToBlock(_divider: DividerElement): BlockKitBlock {
  return { type: "divider" };
}

function actionsToBlock(actions: ActionsElement): BlockKitBlock {
  const elements: BlockKitBlock[] = [];
  for (const child of actions.children) {
    const element = actionChildToElement(child);
    if (element) elements.push(element);
  }
  return { type: "actions", elements };
}

function actionChildToElement(
  child: ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement,
): BlockKitBlock | null {
  switch (child.type) {
    case "button":
      return buttonToElement(child);
    case "link-button":
      return linkButtonToElement(child);
    case "select":
      return selectToElement(child);
    case "radio_select":
      return radioSelectToElement(child);
    default:
      return null;
  }
}

function buttonToElement(button: ButtonElement): BlockKitBlock {
  const element: BlockKitBlock = {
    type: "button",
    action_id: button.id,
    text: { type: "plain_text", text: truncatePlainText(button.label) ?? button.label },
  };
  if (button.value !== undefined) element.value = button.value;
  if (button.style && button.style !== "default") element.style = button.style;
  if (button.disabled === true) element.disabled = true;
  if (button.callbackUrl) element.url = button.callbackUrl;
  return element;
}

function linkButtonToElement(button: LinkButtonElement): BlockKitBlock {
  const element: BlockKitBlock = {
    type: "button",
    action_id: `link:${button.url}`,
    text: { type: "plain_text", text: truncatePlainText(button.label) ?? button.label },
    url: button.url,
  };
  if (button.style && button.style !== "default") element.style = button.style;
  return element;
}

function selectToElement(select: SelectElement): BlockKitBlock {
  return {
    type: "static_select",
    action_id: select.id,
    placeholder: {
      type: "plain_text",
      text: select.placeholder ?? select.label,
    },
    options: select.options.map((option) => ({
      text: { type: "plain_text", text: option.label },
      value: option.value,
      ...(option.description
        ? { description: { type: "plain_text", text: option.description } }
        : {}),
    })),
  };
}

function radioSelectToElement(select: RadioSelectElement): BlockKitBlock {
  return {
    type: "radio_buttons",
    action_id: select.id,
    options: select.options.map((option) => ({
      text: { type: "plain_text", text: option.label },
      value: option.value,
      ...(option.description
        ? { description: { type: "plain_text", text: option.description } }
        : {}),
    })),
  };
}

function fieldsToBlock(fields: FieldsElement): BlockKitBlock {
  return {
    type: "section",
    fields: fields.children.map((field) => ({
      type: "mrkdwn",
      text: `*${field.label}*\n${field.value}`,
    })),
  };
}

function linkToBlock(link: LinkElement): BlockKitBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `<${link.url}|${link.label}>` },
  };
}

/**
 * Renders a {@link TableElement} as Slack's native table block when it
 * fits Slack's limits. Slack allows one table block per message, so
 * additional or oversized tables fall back to a fixed-width mrkdwn
 * approximation.
 */
function tableToBlocks(table: TableElement, state: CardToBlocksState): BlockKitBlock[] {
  const MAX_NATIVE_TABLE_ROWS = 100;
  const MAX_NATIVE_TABLE_COLUMNS = 20;
  if (
    !state.usedNativeTable &&
    table.rows.length <= MAX_NATIVE_TABLE_ROWS &&
    table.headers.length <= MAX_NATIVE_TABLE_COLUMNS
  ) {
    state.usedNativeTable = true;
    return [
      {
        type: "table",
        rows: [
          table.headers.map(tableCellToRawText),
          ...table.rows.map((row) => row.map(tableCellToRawText)),
        ],
      },
    ];
  }

  return [tableToFallbackBlock(table)];
}

function tableCellToRawText(value: string): BlockKitBlock {
  return { type: "raw_text", text: value || " " };
}

function tableToFallbackBlock(table: TableElement): BlockKitBlock {
  const widths = table.headers.map((header, columnIndex) => {
    let width = header.length;
    for (const row of table.rows) {
      const cell = row[columnIndex] ?? "";
      if (cell.length > width) width = cell.length;
    }
    return width;
  });

  const headerLine = table.headers.map((header, i) => header.padEnd(widths[i] ?? 0)).join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-|-");
  const rowLines = table.rows.map((row) =>
    table.headers.map((_, i) => (row[i] ?? "").padEnd(widths[i] ?? 0)).join(" | "),
  );
  const body = ["```", headerLine, separator, ...rowLines, "```"].join("\n");
  return { type: "section", text: { type: "mrkdwn", text: body } };
}
