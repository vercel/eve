import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { BootstrapPrompt } from "#runtime/agent/bootstrap-model-utils.js";
import { getPromptContentText } from "#runtime/agent/bootstrap-model-utils.js";

interface AvailableBootstrapSkill {
  readonly description: string;
  readonly name: string;
}

export function getAvailableSkills(prompt: BootstrapPrompt): AvailableBootstrapSkill[] {
  const skillsById = new Map<string, AvailableBootstrapSkill>();

  for (const message of prompt) {
    if (message.role !== "system" && message.role !== "user") {
      continue;
    }

    // The "Available skills" section may be a standalone announcement
    // (dynamic skills) or embedded inside the agent's static instructions
    // (authored skills); parse bullet lines from the section header to the
    // first blank line either way. Deferred skills aren't listed, so only
    // these are offered.
    const lines = getPromptContentText(message.content).split("\n");
    const headerIndex = lines.findIndex((line) => line.trim() === "Available skills");

    if (headerIndex < 0) {
      continue;
    }

    for (const line of lines.slice(headerIndex + 1)) {
      if (line.trim().length === 0) {
        break;
      }

      const skill = parseAvailableSkill(line);

      if (skill !== null) {
        skillsById.set(skill.name, skill);
      }
    }
  }

  return [...skillsById.values()];
}

export function findRelevantSkill(
  skills: readonly AvailableBootstrapSkill[],
  message: string,
): AvailableBootstrapSkill | null {
  const normalizedMessage = normalizeText(message);

  for (const skill of skills) {
    if (normalizedMessage.includes(normalizeText(skill.name))) {
      return skill;
    }
  }

  if (!/\b(forecast|temperature|weather|wind|rain|snow)\b/u.test(normalizedMessage)) {
    return null;
  }

  return (
    skills.find((skill) =>
      /\b(forecast|temperature|weather|wind|rain|snow)\b/u.test(
        normalizeText(`${skill.name} ${skill.description}`),
      ),
    ) ?? null
  );
}

export function getActivatedSkillIds(prompt: BootstrapPrompt): string[] {
  const fromSystemLabels = prompt
    .filter((message) => message.role === "system")
    .flatMap((message) => {
      return getPromptContentText(message.content)
        .split("\n")
        .map((line) => line.trim())
        .flatMap((line) => {
          const skillMatch = /^Skill \((.+)\)$/.exec(line);
          return skillMatch?.[1] === undefined ? [] : [skillMatch[1]];
        });
    });

  // Static skill adverts stay in the prompt for the whole session (prompt
  // caching), so activation must also be derived from skill loads already
  // present in the history — otherwise the mock would re-load the same skill
  // on every step.
  return [...fromSystemLabels, ...getSkillLoads(prompt).values()];
}

/** Skill loads in the history: each `execute({ skill })` call's id and skill. */
export function getSkillLoads(prompt: BootstrapPrompt): ReadonlyMap<string, string> {
  const loads = new Map<string, string>();

  for (const message of prompt) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (
        typeof part === "string" ||
        part.type !== "tool-call" ||
        part.toolName !== EXECUTE_TOOL_NAME
      ) {
        continue;
      }

      const skill = readSkillFromToolInput(part.input);
      if (skill !== undefined) {
        loads.set(part.toolCallId, skill);
      }
    }
  }

  return loads;
}

function readSkillFromToolInput(input: unknown): string | undefined {
  const parsed = typeof input === "string" ? safeJsonParse(input) : input;

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "skill" in parsed &&
    typeof parsed.skill === "string"
  ) {
    return parsed.skill;
  }

  return undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseAvailableSkill(line: string): AvailableBootstrapSkill | null {
  const directSkillMatch = /^- (.+?): (.+?)(?: \(path: (.+)\))?$/.exec(line.trim());

  if (directSkillMatch?.[1] && directSkillMatch[2]) {
    return {
      description: directSkillMatch[2],
      name: directSkillMatch[1],
    };
  }

  return null;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}
