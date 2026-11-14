import type { MessageContent, MessagePart } from "eve/client";
import type { PromptInputMessage } from "@web/components/ai-elements/prompt-input";

export function messageContent(message: PromptInputMessage): MessageContent {
  const text = message.text.trim();
  if (message.files.length === 0) return text;

  const parts: MessagePart[] = [];
  if (text.length > 0) parts.push({ text, type: "text" });
  for (const file of message.files) {
    parts.push({
      data: file.url,
      filename: file.filename,
      mediaType: file.mediaType,
      type: "file",
    });
  }
  return parts;
}

export function chatTitle(message: PromptInputMessage) {
  const text = message.text.trim();
  if (text) return text.slice(0, 240);
  return message.files[0]?.filename?.slice(0, 240) ?? "New chat";
}
