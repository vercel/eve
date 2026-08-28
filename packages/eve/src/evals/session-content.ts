import { extname } from "node:path";

import type { MessageStreamEvent } from "#protocol/message.js";

/** Formats the user and assistant messages observed in one eval session. */
export function formatEvalTranscript(events: readonly MessageStreamEvent[]): string {
  const messages: string[] = [];
  for (const event of events) {
    if (event.type === "message.received") {
      messages.push(`User:\n${event.data.message}`);
    } else if (event.type === "message.completed" && event.data.message !== null) {
      messages.push(`Assistant:\n${event.data.message}`);
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
