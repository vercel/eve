import { parseFrontmatter, hasFrontmatter } from "#internal/helpers/frontmatter.js";
import {
  normalizeScheduleDefinition,
  normalizeSkillDefinition,
  normalizeInstructionsDefinition,
} from "#internal/authored-definition/core.js";
import { isObject } from "#shared/guards.js";
import { defineSchedule, type ScheduleDefinition } from "#public/definitions/schedule.js";
import { defineSkill, type SkillDefinition } from "#public/definitions/skill.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";

interface ParsedMarkdownDocument {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  markdown: string;
}

function parseMarkdownDocument(source: string): ParsedMarkdownDocument {
  if (!hasFrontmatter(source)) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      markdown: source,
    };
  }

  const document = parseFrontmatter(source);
  if (document === undefined) {
    throw new Error("Markdown frontmatter is missing a closing delimiter.");
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

export function lowerInstructionsMarkdown(markdown: string): InstructionsDefinition {
  return normalizeInstructionsDefinition(
    { content: markdown, role: "system" },
    "Expected authored instructions markdown to match the public eve shape.",
  );
}

interface LowerSkillMarkdownInput {
  readonly description?: string;
  readonly slug?: string;
}

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
    content: document.markdown,
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

  const frontmatter = document.frontmatter;
  const frontmatterDescription = toOptionalString(frontmatter.description, "description");

  const description =
    slug === undefined
      ? requireStringFrontmatter(frontmatter.description, "description")
      : (frontmatterDescription ??
        input.description ??
        deriveFlatSkillDescription(document.markdown, slug));

  const rawDefinition: Record<string, unknown> = {
    description,
    content: document.markdown,
  };

  applyOptionalSkillFrontmatter(rawDefinition, frontmatter);

  return defineSkill(
    normalizeSkillDefinition(
      rawDefinition,
      "Expected authored skill markdown to match the public eve shape.",
    ),
  );
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

  const metadata = toOptionalStringRecord(frontmatter.metadata);
  if (metadata !== undefined) {
    rawDefinition.metadata = metadata;
  }

  const deferred = frontmatter.deferred;
  if (deferred !== undefined && deferred !== null) {
    if (typeof deferred !== "boolean") {
      throw new Error('Expected "deferred" frontmatter to be true or false.');
    }
    rawDefinition.deferred = deferred;
  }
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

function toOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
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
