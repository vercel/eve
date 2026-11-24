export const TOOL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const TOOL_SLUG_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.";

export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export const SKILL_NAME_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter or digit, up to 64 characters.";

export const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
