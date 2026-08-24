import { formatSlackLink } from "#compiled/@chat-adapter/slack/format.js";
import { isObject } from "#shared/guards.js";

/** Derives inbound mrkdwn from top-level text plus Block Kit and legacy attachments. */
export function resolveSlackInboundMrkdwn(text: string, raw: Record<string, unknown>): string {
  const extracted = extractSlackStructuredMrkdwn(raw.blocks, raw.attachments);
  const trimmedText = text.trim();

  if (!trimmedText) return extracted;
  if (!extracted) return text;

  if (normalizeComparableText(extracted) === normalizeComparableText(trimmedText)) {
    return text;
  }

  const normalizedExtracted = normalizeComparableText(extracted);
  const normalizedTrimmed = normalizeComparableText(trimmedText);

  if (extracted.length > trimmedText.length && normalizedExtracted.includes(normalizedTrimmed)) {
    return extracted;
  }

  if (extracted.length >= trimmedText.length * 2) {
    const hasLegacyAttachments = Array.isArray(raw.attachments) && raw.attachments.length > 0;
    if (hasLegacyAttachments && !normalizedExtracted.includes(normalizedTrimmed)) {
      return `${text}\n${extracted}`;
    }
    return extracted;
  }

  return text;
}

function extractSlackStructuredMrkdwn(blocks: unknown, legacyAttachments: unknown): string {
  const lines = [
    ...extractBlockKitLines(blocks),
    ...extractLegacyAttachmentLines(legacyAttachments),
  ];
  return lines.join("\n").trim();
}

function extractBlockKitLines(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];

  const lines: string[] = [];
  for (const block of blocks) {
    if (!isObject(block)) continue;

    switch (block.type) {
      case "section":
        appendTextObjectLine(lines, block.text);
        appendFieldLines(lines, block.fields);
        appendSectionAccessoryLine(lines, block.accessory);
        break;
      case "header":
        appendTextObjectLine(lines, block.text);
        break;
      case "video":
        appendTextObjectLine(lines, block.title);
        appendTextObjectLine(lines, block.description);
        break;
      // The markdown block carries a raw markdown string, not a text object.
      case "markdown":
        if (typeof block.text === "string" && block.text.length > 0) {
          lines.push(block.text);
        }
        break;
      case "table":
      case "data_table":
        appendTableLines(lines, block);
        break;
      case "card":
        appendCardLines(lines, block);
        break;
      case "carousel":
        if (Array.isArray(block.elements)) {
          for (const card of block.elements) {
            if (isObject(card)) appendCardLines(lines, card);
          }
        }
        break;
      case "container":
        appendTextObjectLine(lines, block.title);
        appendTextObjectLine(lines, block.subtitle);
        lines.push(...extractBlockKitLines(block.child_blocks));
        break;
      case "context":
        appendElementLines(lines, block.elements);
        break;
      case "actions":
        appendActionsLine(lines, block.elements);
        break;
      case "rich_text":
        appendRichTextLine(lines, block.elements);
        break;
      case "image":
        if (typeof block.alt_text === "string" && block.alt_text.length > 0) {
          lines.push(block.alt_text);
        }
        if (typeof block.title === "object" && block.title !== null) {
          appendTextObjectLine(lines, block.title);
        }
        break;
      default:
        break;
    }
  }

  return lines;
}

function extractLegacyAttachmentLines(legacyAttachments: unknown): string[] {
  if (!Array.isArray(legacyAttachments)) return [];

  const lines: string[] = [];
  for (const attachment of legacyAttachments) {
    if (!isObject(attachment)) continue;

    const attachmentStart = lines.length;

    if (typeof attachment.pretext === "string" && attachment.pretext.length > 0) {
      lines.push(attachment.pretext);
    }
    if (typeof attachment.title === "string" && attachment.title.length > 0) {
      lines.push(attachment.title);
    }
    if (typeof attachment.text === "string" && attachment.text.length > 0) {
      lines.push(attachment.text);
    }
    appendLegacyFieldLines(lines, attachment.fields);
    if (typeof attachment.footer === "string" && attachment.footer.length > 0) {
      lines.push(attachment.footer);
    }
    lines.push(...extractBlockKitLines(attachment.blocks));
    // Fallback is per-attachment and only when this attachment has no other
    // visible fields; nested blocks count, and earlier attachments must not
    // suppress a later fallback.
    if (
      lines.length === attachmentStart &&
      typeof attachment.fallback === "string" &&
      attachment.fallback.length > 0
    ) {
      lines.push(attachment.fallback);
    }
  }

  return lines;
}

function appendTextObjectLine(lines: string[], textObject: unknown): void {
  const text = readSlackTextObject(textObject);
  if (text) lines.push(text);
}

function appendFieldLines(lines: string[], fields: unknown): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    appendTextObjectLine(lines, field);
  }
}

function appendElementLines(lines: string[], elements: unknown): void {
  if (!Array.isArray(elements)) return;
  for (const element of elements) {
    if (!isObject(element)) continue;
    if (element.type === "image") {
      if (typeof element.alt_text === "string" && element.alt_text.length > 0) {
        lines.push(element.alt_text);
      }
      continue;
    }
    appendTextObjectLine(lines, element);
  }
}

function appendSectionAccessoryLine(lines: string[], accessory: unknown): void {
  if (!isObject(accessory)) return;
  if (accessory.type === "button") {
    appendActionsLine(lines, [accessory]);
  }
}

function appendCardLines(lines: string[], card: Record<string, unknown>): void {
  appendTextObjectLine(lines, card.title);
  appendTextObjectLine(lines, card.subtitle);
  appendTextObjectLine(lines, card.body);
  appendTextObjectLine(lines, card.subtext);
  appendActionsLine(lines, card.actions);
}

function appendTableLines(lines: string[], block: Record<string, unknown>): void {
  appendTextObjectLine(lines, block.caption);
  if (!Array.isArray(block.rows)) return;
  for (const row of block.rows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map(tableCellToPlain);
    if (cells.some((cell) => cell.length > 0)) {
      lines.push(cells.join(" | "));
    }
  }
}

function tableCellToPlain(cell: unknown): string {
  if (!isObject(cell)) return "";
  if (cell.type === "rich_text") return richTextPartsToPlain(cell.elements);
  if (typeof cell.text === "string") return cell.text;
  if (typeof cell.value === "number" || typeof cell.value === "string") {
    return String(cell.value);
  }
  return "";
}

// Bracketed so the model can tell interactive controls apart from body copy.
function appendActionsLine(lines: string[], elements: unknown): void {
  if (!Array.isArray(elements)) return;
  const labels = elements
    .map((element) => (isObject(element) ? readSlackTextObject(element.text) : ""))
    .filter((label) => label.length > 0);
  if (labels.length > 0) {
    lines.push(labels.map((label) => `[${label}]`).join(" "));
  }
}

function appendLegacyFieldLines(lines: string[], fields: unknown): void {
  if (!Array.isArray(fields)) return;
  for (const field of fields) {
    if (!isObject(field)) continue;
    const title = typeof field.title === "string" ? field.title.trim() : "";
    const value = typeof field.value === "string" ? field.value.trim() : "";
    if (title && value) {
      lines.push(`${title}: ${value}`);
    } else if (value) {
      lines.push(value);
    } else if (title) {
      lines.push(title);
    }
  }
}

function appendRichTextLine(lines: string[], elements: unknown): void {
  const text = richTextPartsToPlain(elements);
  if (text) lines.push(text);
}

function richTextPartsToPlain(elements: unknown): string {
  if (!Array.isArray(elements)) return "";
  return elements
    .map((element) => (isObject(element) ? richTextPartToPlain(element) : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function richTextPartToPlain(element: Record<string, unknown>): string {
  switch (element.type) {
    case "rich_text_section":
    case "rich_text_preformatted":
    case "rich_text_quote":
      return richTextInlineToPlain(element.elements);
    case "rich_text_list":
      return richTextListToPlain(element);
    default:
      return "";
  }
}

function richTextInlineToPlain(elements: unknown): string {
  if (!Array.isArray(elements)) return "";

  const parts: string[] = [];
  for (const element of elements) {
    if (!isObject(element)) continue;

    switch (element.type) {
      case "text":
        if (typeof element.text === "string") parts.push(element.text);
        break;
      case "link":
        if (typeof element.url === "string" && typeof element.text === "string") {
          parts.push(formatInboundRichTextLink(element.url, element.text));
        } else if (typeof element.text === "string") {
          parts.push(element.text);
        } else if (typeof element.url === "string") {
          parts.push(element.url);
        }
        break;
      case "emoji":
        if (typeof element.name === "string") parts.push(`:${element.name}:`);
        break;
      // Mentions become mrkdwn tokens so slackMrkdwnToGfm renders them the
      // same way it renders mentions in top-level text.
      case "user":
        if (typeof element.user_id === "string") parts.push(`<@${element.user_id}>`);
        break;
      case "channel":
        if (typeof element.channel_id === "string") parts.push(`<#${element.channel_id}>`);
        break;
      case "usergroup":
        if (typeof element.usergroup_id === "string") {
          parts.push(`<!subteam^${element.usergroup_id}>`);
        }
        break;
      case "broadcast":
        if (typeof element.range === "string") parts.push(`<!${element.range}>`);
        break;
      case "date":
        if (typeof element.fallback === "string") parts.push(element.fallback);
        break;
      default:
        break;
    }
  }

  return parts.join("");
}

function richTextListToPlain(list: Record<string, unknown>): string {
  if (!Array.isArray(list.elements)) return "";
  return list.elements
    .map((item) => (isObject(item) ? richTextInlineToPlain(item.elements) : ""))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Reads the `text` string from a Slack composition text object (`{ text: "..." }`). */
export function readSlackTextObject(textObject: unknown): string {
  if (!isObject(textObject)) return "";
  return typeof textObject.text === "string" ? textObject.text : "";
}

function normalizeComparableText(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}

function formatInboundRichTextLink(url: string, label: string): string {
  try {
    return formatSlackLink(url, label);
  } catch (error) {
    if (error instanceof TypeError) {
      return `${label} (${url})`;
    }
    throw error;
  }
}
