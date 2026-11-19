import "#internal/workflow/builtins.js";

import { normalizeEveAttributes, type EveAttributeValue } from "#runtime/attributes/normalize.js";

export {
  EVE_ATTRIBUTE_VALUE_MAX_BYTES,
  type EveAttributeValue,
  truncateForTag,
} from "#runtime/attributes/normalize.js";

let WARNED_ABOUT_TAG_FAILURE = false;

export async function setEveAttributes(attrs: Record<string, EveAttributeValue>): Promise<void> {
  const normalized = normalizeEveAttributes(attrs);

  if (Object.keys(normalized).length === 0) {
    return;
  }

  try {
    const { setAttributes } = await import("#compiled/@workflow/core/index.js");
    await setAttributes(normalized, { allowReservedAttributes: true });
  } catch (error) {
    if (isTerminalRunAttributeError(error)) return;
    if (!WARNED_ABOUT_TAG_FAILURE) {
      WARNED_ABOUT_TAG_FAILURE = true;
      console.warn("[eve] setEveAttributes failed; suppressing further warnings this process.", {
        keys: Object.keys(normalized),
        error: (error as Error).message,
      });
    }
  }
}

function isTerminalRunAttributeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Cannot set attributes on run in terminal state")
  );
}
