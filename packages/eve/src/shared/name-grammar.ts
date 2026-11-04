// The name rules the runtime checks as well as discovery: what a tool, skill or connection may be
// called. Kept apart from discovery, which reads the filesystem, so the runtime loads without it.

/**
 * Tool filename charset. The slug must start with an ASCII letter and may
 * contain ASCII letters, digits, underscores, and dashes. The 64-character
 * cap matches the most restrictive provider tool-name limit.
 *
 * The model-facing tool name is the filename slug verbatim — there is no
 * authored `name` override and no compile-time normalization. Authors who
 * want a snake_case identifier should name the file in snake_case.
 */
export const TOOL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** {@link TOOL_SLUG_PATTERN} in words, for errors about a name that breaks it. */
export const TOOL_SLUG_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter, up to 64 characters.";

/**
 * Skill name charset: {@link TOOL_SLUG_PATTERN}, except that a name may start
 * with a digit, so a skill such as `3d-modeling` from the Agent Skills
 * standard ports over as-is. A skill is loaded by name, never called as a
 * tool, so tool-name limits on the first character don't apply.
 */
export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** {@link SKILL_NAME_PATTERN} in words, for errors about a name that breaks it. */
export const SKILL_NAME_RULE =
  "Expected ASCII letters, digits, underscores, and dashes only, starting with a letter or digit, up to 64 characters.";

/**
 * Connection filename charset. Connections use the same lowercase
 * kebab-case rule as sandbox since they are not directly exposed to
 * model APIs as identifiers.
 */
export const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
