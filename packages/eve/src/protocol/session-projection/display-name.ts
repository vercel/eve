export function displayName(identifier: string): string {
  const words = lastSegment(identifier)
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(SEPARATORS)
    .filter((word) => word !== "")
    .map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase()));
  return words.length === 0 ? identifier : words.join(" ");
}

export function displayTitle(identifier: string): string {
  return capitalize(displayName(identifier));
}

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
