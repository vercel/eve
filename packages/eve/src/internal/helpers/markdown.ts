import { parseFrontmatter, hasFrontmatter } from "#internal/helpers/gray-matter.js";
import {
  normalizeScheduleDefinition,
  normalizeSkillDefinition,
  normalizeInstructionsDefinition,
} from "#internal/authored-definition/core.js";
import { isObject } from "#shared/guards.js";
import { defineSchedule, type ScheduleDefinition } from "#public/definitions/schedule.js";
import { defineSkill, type SkillDefinition } from "#public/definitions/skill.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";

const CLOSED_FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * Parsed markdown document with optional YAML frontmatter.
 */
interface ParsedMarkdownDocument {
  /**
   * Whether the source started with a parsed frontmatter block.
   */
  hasFrontmatter: boolean;
  /**
   * Parsed frontmatter object. Empty when the source does not include a
   * frontmatter block.
   */
  frontmatter: Record<string, unknown>;
  /**
   * Markdown body content after stripping the frontmatter delimiters.
   */
  markdown: string;
}

/**
 * Parses markdown with optional YAML frontmatter.
 */
function parseMarkdownDocument(source: string): ParsedMarkdownDocument {
  if (!hasFrontmatter(source)) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      markdown: source,
    };
  }

  let document: {
    content: string;
    data: unknown;
  };

  try {
    document = parseFrontmatter(source);
  } catch (error) {
    if (startsWithFrontmatterFence(source) && !hasClosedFrontmatterFence(source)) {
      throw new Error("Markdown frontmatter is missing a closing delimiter.");
    }

    throw error;
  }

  if (!isObject(document.data)) {
    throw new Error("Markdown frontmatter must parse to an object.");
  }

  return {
    hasFrontmatter: true,
    frontmatter: document.data,
    markdown: normalizeFrontmatterMarkdownBody(document.content),
  };
}

/**
 * Lowers authored instructions prompt markdown into the shared public
 * definition shape. Instructions identity is path-derived, so the lowered
 * definition never carries a `name`.
 */
export function lowerInstructionsMarkdown(markdown: string): InstructionsDefinition {
  return normalizeInstructionsDefinition(
    { markdown },
    "Expected authored instructions markdown to match the public eve shape.",
  );
}

/**
 * Optional input for {@link lowerSkillMarkdown}.
 *
 * `slug` is the path-derived skill identifier (the directory name for a
 * skill package, or the filename for a flat skill); it is used only to
 * derive a sensible default description when the markdown body has none.
 * Skill identity itself comes from the file path — the lowered definition
 * never carries a `name`.
 */
interface LowerSkillMarkdownInput {
  readonly description?: string;
  readonly slug?: string;
}

/**
 * Lowers authored skill markdown into the shared public definition shape.
 *
 * Supports both packaged skill files (`SKILL.md` inside a skill
 * directory; description comes from frontmatter) and flat skill files
 * (`<name>.md` next to other skills; description may be derived from
 * the markdown body). Identity is path-derived, so an authored `name`
 * frontmatter field is silently ignored — `SKILL.md` files commonly
 * carry one for compatibility with the broader Agent Skills ecosystem,
 * and we accept it without using it rather than rejecting the file.
 */
/**
 * Lowers an authored schedule markdown file into the shared public
 * definition shape. The frontmatter must contain `cron`. The body
 * becomes the schedule's `markdown` (the fire-and-forget prompt the
 * agent runs when the cron fires). Markdown-form schedules cannot
 * declare a `run` handler — use the `.ts` form for handler-based
 * schedules. Schedule identity is path-derived, so the lowered
 * definition never carries a `name`.
 */
export function lowerScheduleMarkdown(source: string): ScheduleDefinition {
  const document = parseMarkdownDocument(source);

  if (!document.hasFrontmatter) {
    throw new Error('Schedule markdown must start with YAML frontmatter declaring "cron".');
  }

  if ("run" in document.frontmatter) {
    throw new Error(
      'Markdown-form schedules do not support the "run" frontmatter key. Use a TypeScript schedule (`<name>.ts`) to author a handler.',
    );
  }

  const rawDefinition: Record<string, unknown> = {
    ...document.frontmatter,
    markdown: document.markdown,
  };

  return defineSchedule(
    normalizeScheduleDefinition(
      rawDefinition,
      "Expected authored schedule markdown to match the public eve shape.",
    ),
  );
}

export function lowerSkillMarkdown(
  source: string,
  input: LowerSkillMarkdownInput = {},
): SkillDefinition {
  const document = parseMarkdownDocument(source);
  const slug = input.slug;

  if (slug === undefined && !document.hasFrontmatter) {
    throw new Error("Skill markdown must start with YAML frontmatter.");
  }

  const frontmatter = stripIgnoredSkillFrontmatterKeys(document.frontmatter);
  const frontmatterDescription = toOptionalString(frontmatter.description, "description");

  const description =
    slug === undefined
      ? requireStringFrontmatter(frontmatter.description, "description")
      : (frontmatterDescription ??
        input.description ??
        deriveFlatSkillDescription(document.markdown, slug));

  const rawDefinition: Record<string, unknown> = {
    ...frontmatter,
    description,
    markdown: document.markdown,
  };

  applyOptionalSkillFrontmatter(rawDefinition, frontmatter);

  return defineSkill(
    normalizeSkillDefinition(
      rawDefinition,
      "Expected authored skill markdown to match the public eve shape.",
    ),
  );
}

function startsWithFrontmatterFence(source: string): boolean {
  return source.startsWith("---\n") || source.startsWith("---\r\n");
}

function hasClosedFrontmatterFence(source: string): boolean {
  return CLOSED_FRONTMATTER_PATTERN.test(source);
}

function normalizeFrontmatterMarkdownBody(markdown: string): string {
  return markdown.replace(/^\r?\n/u, "");
}

function applyOptionalSkillFrontmatter(
  rawDefinition: Record<string, unknown>,
  frontmatter: Record<string, unknown>,
): void {
  const license = toOptionalString(frontmatter.license, "license");
  if (license !== undefined) {
    rawDefinition.license = license;
  }

  const metadata = toOptionalStringRecord(frontmatter.metadata, "metadata");
  if (metadata !== undefined) {
    rawDefinition.metadata = metadata;
  }
}

/**
 * Removes frontmatter keys that the broader Agent Skills format permits but
 * eve deliberately does not consume. Skill identity is path-derived, so an
 * authored `name` is meaningless to eve; we drop it silently rather than
 * letting it surface as an unknown-key error during normalization.
 */
const IGNORED_SKILL_FRONTMATTER_KEYS = ["name"];

function stripIgnoredSkillFrontmatterKeys(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  let stripped: Record<string, unknown> = { ...frontmatter };
  for (const key of IGNORED_SKILL_FRONTMATTER_KEYS) {
    delete stripped[key];
  }
  return stripped;
}

function toOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected "${fieldName}" frontmatter to be a string.`);
  }

  return value;
}

function requireStringFrontmatter(value: unknown, fieldName: string): string {
  const normalizedValue = toOptionalString(value, fieldName);

  if (normalizedValue === undefined) {
    throw new Error(`Missing required "${fieldName}" frontmatter.`);
  }

  return normalizedValue;
}

function toOptionalStringRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`Expected "${fieldName}" frontmatter to be an object.`);
  }

  const stringEntries = Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw new Error(`Expected "${fieldName}.${key}" frontmatter to be a string.`);
    }

    return [key, entryValue] as const;
  });

  return Object.fromEntries(stringEntries);
}

function deriveFlatSkillDescription(markdown: string, name: string): string {
  const descriptionLine = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("```"));

  if (descriptionLine === undefined) {
    return `Instructions for the ${name} skill.`;
  }

  return (
    descriptionLine.replace(/^[#>*\-\s]+/u, "").trim() || `Instructions for the ${name} skill.`
  );
}
