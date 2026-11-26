import { describeFilePart } from "#internal/attachments/file-part.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { MessageContent } from "#shared/message-content.js";

export function userPartsOf(message: MessageContent): readonly UserPart[] {
  if (typeof message === "string") return [{ kind: "text", text: message }];
  return message.map((part) =>
    part.type === "text"
      ? { kind: "text", text: part.text }
      : { kind: "file", ...describeFilePart(part.data, part.mediaType, part.filename) },
  );
}
