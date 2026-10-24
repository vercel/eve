import type { UserContent } from "ai";

import { createFrameworkUserMessage } from "#harness/messages.js";

/** Builds the user-role message a strategy returns, such as a checkpoint marker. */
export function createCompactionUserMessage(content: UserContent) {
  return createFrameworkUserMessage("context.compaction", content);
}
