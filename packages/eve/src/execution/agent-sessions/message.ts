import type { JsonObject, JsonValue } from "#shared/json.js";
import {
  MAX_MESSAGE_PARTS,
  type MessageContent,
  type MessagePart,
} from "#shared/message-content.js";

/** Workflow messages carry references, not attachment bytes, through durable step inputs. */
export function normalizeAgentMessage(
  message: MessageContent<string | URL>,
): string | readonly (MessagePart<string> & JsonObject)[] {
  if (typeof message === "string") {
    if (message.trim() === "")
      throw new TypeError("ctx.agent().send() requires a non-empty message.");
    return message;
  }
  if (!Array.isArray(message) || message.length === 0 || message.length > MAX_MESSAGE_PARTS) {
    throw new TypeError("ctx.agent().send() requires text or between 1 and 64 text/file parts.");
  }
  const parts = message.map((part: MessagePart<string | URL>): MessagePart<string> & JsonObject => {
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    const invalidFile = () =>
      new TypeError(
        "ctx.agent().send() file parts require an HTTP(S) URL, not inline bytes or base64.",
      );
    if (part.type !== "file" || (typeof part.data !== "string" && !(part.data instanceof URL)))
      throw invalidFile();
    let url: URL;
    try {
      url = new URL(String(part.data));
    } catch {
      throw invalidFile();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidFile();
    const file: Record<string, JsonValue> & { type: "file"; data: string; mediaType: string } = {
      type: "file",
      data: url.href,
      mediaType: part.mediaType,
    };
    if (part.filename !== undefined) file.filename = part.filename;
    return file;
  });
  if (!parts.some((part) => part.type === "file" || part.text.trim() !== "")) {
    throw new TypeError("ctx.agent().send() requires a non-empty message.");
  }
  return parts;
}
