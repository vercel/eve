import { stripTerminalControls, visibleLength, wrapVisibleLine } from "#cli/ui/terminal-text.js";

const CONTINUATION = "  ";

export function formatAttributeContent(
  key: string,
  value: unknown,
  dim: (text: string) => string,
  width: number,
): string[] {
  if (typeof value !== "string") {
    if (Array.isArray(value)) return prettyJson(value, width);
    return [stripTerminalControls(shortJson(value))];
  }
  if (key === "gen_ai.input.messages") {
    const transcript = genAiMessageTranscript(value, dim, width);
    if (transcript !== undefined) return transcript;
  }
  return formatPayloadContent(value, width);
}

export function wrapPlainText(text: string, width: number): string[] {
  return splitEmbeddedNewlines([stripTerminalControls(text)]).flatMap((line) =>
    wrapVisibleLine(line, width),
  );
}

export function formatPayloadContent(text: string, width: number): string[] {
  const parsed = parseJson(text);
  if (parsed !== undefined && (Array.isArray(parsed) || isRecord(parsed))) {
    return prettyJson(parsed, width);
  }
  return wrapPlainText(text, width);
}

function genAiMessageTranscript(
  raw: string,
  dim: (text: string) => string,
  width: number,
): string[] | undefined {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every(isGenAiMessage)) return undefined;
  const lines: string[] = [];
  const toolNames = new Map<string, string>();
  for (const message of parsed) {
    const parts = genAiMessageParts(message.parts, toolNames);
    const role =
      message.role === "tool" ? toolRoleLabel(parts) : stripTerminalControls(String(message.role));
    parts.forEach((part, index) => {
      const prefix = index === 0 ? `${dim(`${role}:`)} ` : CONTINUATION;
      lines.push(...wrapPrefixed(prefix, part.text, part.dim ? dim : undefined, width));
    });
  }
  return lines;
}

function toolRoleLabel(parts: readonly MessageContentPart[]): string {
  const named = parts.find((part) => part.name !== undefined);
  return named?.name === undefined ? "tool" : `tool ${named.name}`;
}

interface MessageContentPart {
  readonly text: string;
  readonly dim?: boolean;
  readonly name?: string;
}

function genAiMessageParts(value: unknown, toolNames: Map<string, string>): MessageContentPart[] {
  if (!Array.isArray(value)) return [{ text: shortJson(value) }];
  const parts: MessageContentPart[] = [];
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string") {
      parts.push({ text: shortJson(part) });
      continue;
    }
    if (part.type === "text" && typeof part.content === "string") {
      parts.push({ text: stripTerminalControls(part.content) });
    } else if (part.type === "reasoning") {
      const text =
        typeof part.content === "string" ? stripTerminalControls(part.content.trim()) : "";
      parts.push({ dim: true, text: text.length > 0 ? `⟨reasoning⟩ ${text}` : "⟨reasoning⟩" });
    } else if (part.type === "tool_call" && typeof part.name === "string") {
      const name = stripTerminalControls(part.name);
      if (typeof part.id === "string") toolNames.set(part.id, name);
      parts.push({ name, text: `→ ${name}(${shortJson(part.arguments)})` });
    } else if (part.type === "tool_call_response") {
      const name = typeof part.id === "string" ? toolNames.get(part.id) : undefined;
      parts.push({ name, text: toolResponseText(part.response) });
    } else {
      parts.push({ text: shortJson(part) });
    }
  }
  if (parts.length === 0) parts.push({ text: shortJson(value) });
  return parts;
}

function toolResponseText(response: unknown): string {
  return typeof response === "string" ? stripTerminalControls(response) : shortJson(response);
}

function prettyJson(value: unknown, width: number): string[] {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .flatMap((line) => wrapHanging(line, width, width));
}

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

function wrapHanging(text: string, width: number, firstWidth: number): string[] {
  const chunks = wrapVisibleLine(text, Math.max(8, width - CONTINUATION.length));
  if (visibleLength(chunks[0] ?? "") <= firstWidth) return chunks;
  const [head, ...rest] = wrapVisibleLine(chunks[0] ?? "", Math.max(8, firstWidth));
  return [head ?? "", ...rest, ...chunks.slice(1)];
}

function splitEmbeddedNewlines(lines: readonly string[]): string[] {
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

function isGenAiMessage(
  value: unknown,
): value is Record<string, unknown> & { readonly role: string } {
  return isRecord(value) && typeof value.role === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
