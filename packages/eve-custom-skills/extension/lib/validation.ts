import { createHash } from "node:crypto";

import { InvalidSkillNameError } from "./errors.ts";
import type { SaveSkillInput, SkillValidation } from "./types.ts";

/**
 * eve caps a skill name at 64 characters, and an extension's dynamic skills
 * load as `<mount>__<prefix><name>`. 40 leaves room for a 14-character mount
 * name plus the `channel-` prefix.
 */
export const MAX_SKILL_NAME_LENGTH = 40;
export const MAX_SKILL_DESCRIPTION_LENGTH = 280;
export const MAX_SKILL_MARKDOWN_LENGTH = 20_000;

const ROUTING_CONDITION = /^use when (?:the )?user (?:asks|requests|wants|needs)\b/i;

export const ROUTING_DESCRIPTION_REQUIREMENT =
  'An on-demand or deferred skill\'s description must be a routing condition starting with "Use when the user asks", "requests", "wants", or "needs" — for example "Use when the user asks for a production deploy checklist." Describe the request that should load the skill, and keep behavior instructions in the skill body.';

export function isRoutingDescription(description: string): boolean {
  return ROUTING_CONDITION.test(description.trim());
}

export function pathSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeSkillName(raw: string): string {
  const normalized = pathSafe(raw.trim()).slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/g, "");
  if (!normalized) {
    throw new InvalidSkillNameError(
      "Skill name must contain at least one letter or number (it becomes a lowercase, hyphenated identifier).",
    );
  }
  return normalized;
}

const SUSPICIOUS_INSTRUCTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|system|developer)\s+instructions/i,
    "Instructions appear to override higher-priority instructions; review before activation.",
  ],
  [
    /bypass.{0,40}(?:approval|authorization|permission|policy)/i,
    "Instructions appear to bypass an approval or authorization boundary; review before activation.",
  ],
  [
    /(?:exfiltrate|leak|steal|send).{0,60}(?:secret|credential|token|password)/i,
    "Instructions mention moving secrets or credentials; review before activation.",
  ],
];

function containsUnsupportedControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export function normalizeSkillInput(input: SaveSkillInput): SaveSkillInput {
  const normalized: SaveSkillInput = {
    name: normalizeSkillName(input.name),
    description: input.description.trim().replace(/\s+/g, " "),
    markdown: input.markdown.trim(),
  };
  if (input.applicationMode) normalized.applicationMode = input.applicationMode;
  return normalized;
}

/** Errors block a save; warnings save the version as a draft for review. */
export function validateSkillContent(input: SaveSkillInput): SkillValidation {
  const { description, markdown } = normalizeSkillInput(input);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!description) errors.push("A skill description is required.");
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    errors.push(`Skill description must be ${MAX_SKILL_DESCRIPTION_LENGTH} characters or fewer.`);
  }
  if (!markdown) errors.push("Skill instructions (markdown) are required.");
  if (markdown.length > MAX_SKILL_MARKDOWN_LENGTH) {
    errors.push(`Skill instructions must be ${MAX_SKILL_MARKDOWN_LENGTH} characters or fewer.`);
  }
  if (
    containsUnsupportedControlCharacters(description) ||
    containsUnsupportedControlCharacters(markdown)
  ) {
    errors.push("Skill content contains unsupported control characters.");
  }
  for (const [pattern, warning] of SUSPICIOUS_INSTRUCTION_PATTERNS) {
    if (pattern.test(markdown)) warnings.push(warning);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function skillChecksum(name: string, description: string, markdown: string): string {
  return createHash("sha256").update(JSON.stringify({ name, description, markdown })).digest("hex");
}
