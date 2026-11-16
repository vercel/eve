import { createHash } from "node:crypto";

import { InvalidSkillContentError, InvalidSkillNameError } from "./errors.ts";
import type { SkillValidation, SkillValidationInput, SkillValidator } from "./types.ts";

/** Size limits for custom skills. Every field is per scope or per skill. */
export interface SkillLimits {
  /** Skills per scope. */
  readonly maxSkills: number;
  /** Always-on skills per scope. */
  readonly maxAlwaysOn: number;
  /** Combined always-on instructions per scope, in characters. */
  readonly maxAlwaysOnCharacters: number;
  /**
   * A skill name's length. eve caps a loadable skill name at 64 characters,
   * and custom skills load as `<mount>__<scope prefix><name>`, so leave room
   * for both.
   */
  readonly maxNameLength: number;
  readonly maxDescriptionLength: number;
  readonly maxInstructionsLength: number;
}

export const DEFAULT_LIMITS: SkillLimits = {
  maxSkills: 100,
  maxAlwaysOn: 5,
  maxAlwaysOnCharacters: 20_000,
  maxNameLength: 40,
  maxDescriptionLength: 280,
  maxInstructionsLength: 20_000,
};

/** The largest values a tool input accepts; the configured limits apply on top. */
export const INPUT_CEILINGS = {
  name: 64,
  description: 2_000,
  instructions: 200_000,
} as const;

const ROUTING_CONDITION = /^use when (?:the )?user (?:asks|requests|wants|needs)\b/i;

export const ROUTING_DESCRIPTION_REQUIREMENT =
  'An on-demand or deferred skill\'s description must be a routing condition starting with "Use when the user asks", "requests", "wants", or "needs" — for example "Use when the user asks for a production deploy checklist." Describe the request that should load the skill, and keep behavior instructions in the skill body.';

export function isRoutingDescription(description: string): boolean {
  return ROUTING_CONDITION.test(description.trim());
}

/** The extension's own skill names, which a custom skill without a load prefix would shadow. */
const RESERVED_NAMES = new Set(["manage"]);

export function normalizeSkillName(raw: string, maxLength: number): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new InvalidSkillNameError(
      "Skill name must contain at least one letter or number (it becomes a lowercase, hyphenated identifier).",
    );
  }
  if (normalized.length > maxLength) {
    throw new InvalidSkillNameError(`Skill name must be ${maxLength} characters or fewer.`);
  }
  if (RESERVED_NAMES.has(normalized)) {
    throw new InvalidSkillNameError(
      `"${normalized}" is the name of this extension's own skill. Pick another name.`,
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

export interface SkillContent {
  readonly description: string;
  readonly markdown: string;
}

export function normalizeSkillContent(input: SkillContent): SkillContent {
  return {
    description: input.description.trim().replace(/\s+/g, " "),
    markdown: input.markdown.trim(),
  };
}

/**
 * The checks no validator replaces: required fields, configured sizes, and
 * control characters.
 */
export function checkSkillLimits(input: SkillContent, limits: SkillLimits): string[] {
  const { description, markdown } = input;
  const errors: string[] = [];
  if (!description) errors.push("A skill description is required.");
  if (description.length > limits.maxDescriptionLength) {
    errors.push(`Skill description must be ${limits.maxDescriptionLength} characters or fewer.`);
  }
  if (!markdown) errors.push("Skill instructions (markdown) are required.");
  if (markdown.length > limits.maxInstructionsLength) {
    errors.push(`Skill instructions must be ${limits.maxInstructionsLength} characters or fewer.`);
  }
  if (
    containsUnsupportedControlCharacters(description) ||
    containsUnsupportedControlCharacters(markdown)
  ) {
    errors.push("Skill content contains unsupported control characters.");
  }
  return errors;
}

/**
 * The built-in content rules: an on-demand or deferred description must be a
 * routing condition, and instructions that try to override higher-priority
 * rules, bypass approval, or move secrets raise warnings. Warnings are only
 * raised on save, where they hold a first version in draft.
 */
export const defaultSkillValidator: SkillValidator = (input) => {
  const errors =
    input.applicationMode !== "always" && !isRoutingDescription(input.description)
      ? [ROUTING_DESCRIPTION_REQUIREMENT]
      : [];
  const warnings =
    input.action === "save"
      ? SUSPICIOUS_INSTRUCTION_PATTERNS.flatMap(([pattern, warning]) =>
          pattern.test(input.instructions) ? [warning] : [],
        )
      : [];
  return { errors, warnings };
};

/** Runs the fixed checks and `validator`, and rejects when either finds an error. */
export async function validateSkill(
  input: SkillValidationInput,
  limits: SkillLimits,
  validator: SkillValidator,
): Promise<SkillValidation> {
  const fixed = checkSkillLimits(
    { description: input.description, markdown: input.instructions },
    limits,
  );
  if (fixed.length > 0) throw new InvalidSkillContentError(fixed);
  const result = await validator(input);
  if (result.errors.length > 0) throw new InvalidSkillContentError(result.errors);
  return { valid: true, errors: [], warnings: [...result.warnings] };
}

export function skillChecksum(name: string, description: string, markdown: string): string {
  return createHash("sha256").update(JSON.stringify({ name, description, markdown })).digest("hex");
}
