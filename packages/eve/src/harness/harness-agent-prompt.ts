import type { UserContent, UserModelMessage } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";

export function createHarnessAgentPrompt(input: {
  readonly messages: readonly HarnessModelMessage[];
}): UserModelMessage {
  const content: UserContent = [];
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    if (content.length > 0) content.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") {
      content.push({ type: "text", text: message.content });
    } else {
      content.push(...message.content);
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "Continue the current request." });
  }
  return { role: "user", content };
}
