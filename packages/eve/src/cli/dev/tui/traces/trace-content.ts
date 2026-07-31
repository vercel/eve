/**
 * Formats span attribute values for the `/traces` detail panel. Payload
 * attributes render as readable structure — prompt messages as a chat-like
 * transcript with role-prefixed blocks and hanging indents, JSON as
 * pretty-printed blocks — instead of one wrapped blob. Provider transport
 * noise was already stripped at capture time (see `agent-otel-provider.ts`),
 * so what remains here is presentation only.
 *
 * Every returned line fits the given width; wrapped continuations keep a
 * two-space hanging indent so they read as part of their block.
 */

import { stripTerminalControls, visibleLength, wrapVisibleLine } from "#cli/ui/terminal-text.js";

import type { Theme } from "../theme.js";

/** Indent applied to continuation lines within a block. */
const CONTINUATION = "  ";

/**
 * Formats one attribute's value into display lines, each at most `width`
 * columns. A single scalar stays on one line so the panel can keep it beside
 * its key; multi-line content comes back unindented for the caller to nest
 * under the key.
 */
export function formatAttributeContent(
  key: string,
  value: unknown,
  theme: Theme,
  width: number,
): string[] {
  // Non-string OTLP values include arrays whose elements can carry raw
  // escape sequences; JSON-encode them (which escapes control characters)
  // rather than String() them into the frame.
  if (typeof value !== "string") {
    if (Array.isArray(value)) return prettyJson(value, width);
    return [stripTerminalControls(shortJson(value))];
  }
  if (key === "ai.prompt.messages") {
    const transcript = messageTranscript(value, theme, width);
    if (transcript !== undefined) return transcript;
  }
  return formatPayloadContent(value, width);
}

/**
 * Wraps text to `width`, splitting on embedded newlines so a multi-line payload
 * keeps its shape, and stripping control bytes the frame must not carry.
 */
export function wrapPlainText(text: string, width: number): string[] {
  return splitEmbeddedNewlines([stripTerminalControls(text)]).flatMap((line) =>
    wrapVisibleLine(line, width),
  );
}

/** Formats a payload: JSON structure pretty-prints, anything else stays text. */
export function formatPayloadContent(text: string, width: number): string[] {
  const parsed = parseJson(text);
  if (parsed !== undefined && (Array.isArray(parsed) || isRecord(parsed))) {
    return prettyJson(parsed, width);
  }
  return wrapPlainText(text, width);
}

function messageTranscript(raw: string, theme: Theme, width: number): string[] | undefined {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return undefined;
  // Long conversations are front-truncated at capture time with an
  // `eve.truncated` marker; it renders as a notice, not a message.
  let omitted = 0;
  const messages: Record<string, unknown>[] = [];
  for (const item of parsed) {
    if (isRecord(item) && isRecord(item["eve.truncated"])) {
      const count = item["eve.truncated"].omittedMessages;
      if (typeof count === "number") {
        omitted += count;
        continue;
      }
    }
    messages.push(item);
  }
  if (!messages.every((message) => typeof message.role === "string")) {
    return undefined;
  }
  const { colors } = theme;
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(
      colors.dim(`… ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted (long context)`),
    );
  }
  for (const message of messages) {
    const parts = messageContentParts(message.content);
    const role =
      message.role === "tool" ? toolRoleLabel(parts) : stripTerminalControls(String(message.role));
    // The first part sits beside the role prefix; the rest hang underneath.
    parts.forEach((part, index) => {
      const prefix = index === 0 ? `${colors.dim(`${role}:`)} ` : CONTINUATION;
      lines.push(...wrapPrefixed(prefix, part.text, part.dim ? colors.dim : undefined, width));
    });
  }
  return lines;
}

/** Tool-role messages are about one tool; name it in the role label. */
function toolRoleLabel(parts: readonly MessageContentPart[]): string {
  const named = parts.find((part) => part.name !== undefined);
  return named?.name === undefined ? "tool" : `tool ${named.name}`;
}

interface MessageContentPart {
  readonly text: string;
  readonly dim?: boolean;
  readonly name?: string;
}

function messageContentParts(content: unknown): MessageContentPart[] {
  if (typeof content === "string") return [{ text: stripTerminalControls(content) }];
  if (!Array.isArray(content)) return [{ text: shortJson(content) }];
  const parts: MessageContentPart[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") {
      parts.push({ text: shortJson(part) });
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ text: stripTerminalControls(part.text) });
    } else if (part.type === "reasoning") {
      const text = typeof part.text === "string" ? stripTerminalControls(part.text.trim()) : "";
      parts.push({ dim: true, text: text.length > 0 ? `⟨reasoning⟩ ${text}` : "⟨reasoning⟩" });
    } else if (part.type === "tool-call" && typeof part.toolName === "string") {
      const name = stripTerminalControls(part.toolName);
      parts.push({ name, text: `→ ${name}(${shortJson(part.input)})` });
    } else if (part.type === "tool-result" && typeof part.toolName === "string") {
      const name = stripTerminalControls(part.toolName);
      parts.push({ name, text: toolOutputText(part.output) });
    } else {
      parts.push({ text: shortJson(part) });
    }
  }
  if (parts.length === 0) parts.push({ text: shortJson(content) });
  return parts;
}

/**
 * Unwraps the AI SDK's typed output envelopes: `{"type":"text","value":"…"}`
 * renders as the text, `{"type":"json","value":{…}}` as the inner payload's
 * compact JSON. Everything else renders as compact JSON.
 */
function toolOutputText(output: unknown): string {
  if (isRecord(output) && typeof output.type === "string" && "value" in output) {
    if (output.type === "text" && typeof output.value === "string")
      return stripTerminalControls(output.value);
    return shortJson(output.value);
  }
  return shortJson(output);
}

/** Pretty-prints a JSON value with two-space indents, wrapped to `width`. */
export function prettyJson(value: unknown, width: number): string[] {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .flatMap((line) => wrapHanging(line, width, width));
}

/**
 * Wraps `text` at `width` with `prefix` (possibly ANSI-styled) on the first
 * line and the hanging continuation indent on the rest. `dim` styles content
 * only, keeping wrap points independent of ANSI sequences.
 */
function wrapPrefixed(
  prefix: string,
  text: string,
  dim: ((text: string) => string) | undefined,
  width: number,
): string[] {
  const style = dim ?? ((value: string) => value);
  const lines: string[] = [];
  splitEmbeddedNewlines([text]).forEach((logical, logicalIndex) => {
    const head = logicalIndex === 0 ? prefix : CONTINUATION;
    const headWidth = logicalIndex === 0 ? visibleLength(prefix) : CONTINUATION.length;
    const firstWidth = Math.max(8, width - headWidth);
    wrapHanging(logical, width, firstWidth).forEach((chunk, chunkIndex) => {
      lines.push(chunkIndex === 0 ? `${head}${style(chunk)}` : `${CONTINUATION}${style(chunk)}`);
    });
  });
  return lines;
}

/** Word-wraps to `width` where the first line may be tighter (`firstWidth`). */
function wrapHanging(text: string, width: number, firstWidth: number): string[] {
  const chunks = wrapVisibleLine(text, Math.max(8, width - CONTINUATION.length));
  if (visibleLength(chunks[0] ?? "") <= firstWidth) return chunks;
  // The first line shares its row with a prefix: re-wrap just that chunk at
  // the tighter width and fold the overflow ahead of the remaining chunks.
  const [head, ...rest] = wrapVisibleLine(chunks[0] ?? "", Math.max(8, firstWidth));
  return [head ?? "", ...rest, ...chunks.slice(1)];
}

/**
 * Payload text can carry real newlines (tool results frequently end with one).
 * Left raw, they split a composed frame row and inject phantom lines into the
 * frame. Split them into real display lines; a trailing newline's empty tail
 * is dropped.
 */
export function splitEmbeddedNewlines(lines: readonly string[]): string[] {
  const split = lines.flatMap((line) => line.split(/\r\n|\r|\n/));
  while (split.length > 1 && split[split.length - 1] === "") split.pop();
  return split;
}

function shortJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
