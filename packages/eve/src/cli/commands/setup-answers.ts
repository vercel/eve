import { InvalidArgumentError } from "#compiled/commander/index.js";

/** Parses one repeatable `--answer key=<JSON value>`. */
export function parseSetupAnswer(
  value: string,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const separator = value.indexOf("=");
  if (separator < 1) throw new InvalidArgumentError('Expected "key=value".');
  const key = value.slice(0, separator).trim();
  const raw = value.slice(separator + 1);
  if (key.length === 0) throw new InvalidArgumentError("Setup answer key cannot be empty.");
  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new InvalidArgumentError(
      `Setup answer for "${key}" must be JSON; quote string values, for example '${key}="value"'.`,
    );
  }
  return { ...previous, [key]: answer };
}
