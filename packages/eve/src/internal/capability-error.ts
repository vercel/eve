import { formatError } from "#internal/logging.js";
import type { JsonObject } from "#shared/json.js";

/** Keeps transport diagnostics without persisting known capability values or URL encodings. */
export function formatCapabilityError(
  error: unknown,
  capabilities: readonly (string | undefined)[],
): JsonObject {
  const secrets = capabilities
    .filter((value): value is string => value !== undefined && value.length > 0)
    .flatMap((value) => [value, encodeURIComponent(value)])
    .sort((left, right) => right.length - left.length);
  return Object.fromEntries(
    Object.entries(formatError(error)).map(([key, value]) => [
      key,
      typeof value === "string"
        ? secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
        : value,
    ]),
  );
}
