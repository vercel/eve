import type { ModelMessage } from "ai";

import { isObject } from "#shared/guards.js";

export type LoadCandidate = Pick<ModelMessage, "role" | "content" | "providerOptions">;

export function isToolLoad(message: LoadCandidate): boolean {
  return loadedDefinitions(message) !== undefined;
}

function loadedDefinitions(message: LoadCandidate): readonly unknown[] | undefined {
  if (message.role !== "system" || message.content !== "") return undefined;
  const loaded = message.providerOptions?.openai?.additionalTools;
  return Array.isArray(loaded) ? loaded : undefined;
}

export function withoutToolLoads<Message extends LoadCandidate>(
  messages: readonly Message[],
): Message[] {
  return messages.filter((message) => !isToolLoad(message));
}

export function loadedToolNames(messages: readonly LoadCandidate[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      (loadedDefinitions(message) ?? []).flatMap((definition) =>
        isObject(definition) && typeof definition.name === "string" ? [definition.name] : [],
      ),
    ),
  );
}
