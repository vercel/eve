/**
 * Display text for an eve identifier, such as a tool, agent, or skill name:
 * `code__code_reviewer` → `code reviewer`, `getPRStatus` → `get PR status`.
 * Only the last `__` segment names the thing; the segments before it are the
 * extension or memory namespace it was mounted under, which means nothing to
 * someone reading a status.
 */
export function displayName(identifier: string): string {
  const words = lastSegment(identifier)
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(SEPARATORS)
    .filter((word) => word !== "")
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));
  return words.length === 0 ? identifier : words.join(" ");
}

/** {@link displayName} in sentence case, for the start of a title: `Code reviewer`. */
export function displayTitle(identifier: string): string {
  return capitalize(displayName(identifier));
}

/**
 * Display text for a proper noun, such as a connection name: `my_crm` →
 * `My crm`. It keeps the author's casing, since `GitHub` is one word.
 */
export function displayProperName(identifier: string): string {
  const name = lastSegment(identifier)
    .split(SEPARATORS)
    .filter((word) => word !== "")
    .join(" ");
  return name === "" ? identifier : capitalize(name);
}

const SEPARATORS = /[\s_-]+/u;

function lastSegment(identifier: string): string {
  return identifier.split("__").findLast((segment) => segment !== "") ?? identifier;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
