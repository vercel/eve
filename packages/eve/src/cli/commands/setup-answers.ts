import { InvalidArgumentError } from "#compiled/commander/index.js";

/** Parses one repeatable `--answer key=value`; JSON values retain arrays, booleans, and numbers. */
export function parseSetupAnswer(
  value: string,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const separator = value.indexOf("=");
  if (separator < 1) throw new InvalidArgumentError('Expected "key=value".');
  const key = value.slice(0, separator).trim();
  const raw = value.slice(separator + 1);
  if (key.length === 0) throw new InvalidArgumentError("Setup answer key cannot be empty.");
  let answer: unknown = raw;
  try {
    answer = JSON.parse(raw);
  } catch {}
  return { ...previous, [key]: answer };
}
