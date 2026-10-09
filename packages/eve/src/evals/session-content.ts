import type { SessionStreamEvent } from "#protocol/session-event.js";
import { replyTextOf } from "#public/channels/reply.js";
import { extname } from "node:path";

/** Formats the user and assistant messages observed in one eval session. */
export function formatEvalTranscript(events: readonly SessionStreamEvent[]): string {
  const messages: string[] = [];
  for (const event of events) {
    if (event.type === "delivery.consumed") {
      const text = event.data.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
      if (text.length > 0) messages.push(`User:\n${text.join("\n")}`);
    } else if (event.type === "content.completed") {
      const reply = replyTextOf(event.data);
      if (reply !== undefined) messages.push(`Assistant:\n${reply}`);
    }
  }
  return messages.join("\n\n");
}

/** Infers the media type used when an eval attaches a local file. */
export function inferMediaType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
