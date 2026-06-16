import type { BootstrapPrompt } from "#runtime/agent/bootstrap-model-utils.js";
import { getPromptContentText } from "#runtime/agent/bootstrap-model-utils.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";

export interface AvailableBootstrapTool {
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly name: string;
  readonly outputSchema?: unknown;
}

export function createMockAuthoredToolInput(
  tool: AvailableBootstrapTool,
  message: string,
  city: string,
): Record<string, unknown> {
  const inputPropertyNames = getToolInputPropertyNames(tool.inputSchema);
  if (tool.name === "ask_question" || hasProperties(inputPropertyNames, ["prompt", "options"])) {
    return createAskQuestionInput(message);
  }

  if (inputPropertyNames.includes("command")) {
    return { command: resolveShellCommand(message) };
  }

  if (inputPropertyNames.includes("topic") || /\btopic\b/u.test(normalizeText(message))) {
    return { topic: resolveLookupTopic(message) };
  }

  const anchored = extractAnchoredInputs(inputPropertyNames, message);
  if (Object.keys(anchored).length > 0) {
    return anchored;
  }

  if (inputPropertyNames.length === 1 && inputPropertyNames[0] === "message") {
    return { message };
  }

  return { city };
}

/**
 * Extracts tool inputs anchored to schema property names in the message, e.g.
 * `with label "smoke-test"`, ``value `hello```, or `note: 'smoke'`. This lets
 * deterministic smoke evals drive tools whose schemas fall outside the
 * special-cased heuristics above.
 */
function extractAnchoredInputs(
  propertyNames: readonly string[],
  message: string,
): Record<string, string> {
  const inputs: Record<string, string> = {};

  for (const propertyName of propertyNames) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(propertyName)}\\b\\s*(?:to|=|:)?\\s*(?:\`([^\`]+)\`|"([^"]+)"|'([^']+)')`,
      "iu",
    );
    const match = pattern.exec(message);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];

    if (value !== undefined) {
      inputs[propertyName] = value.trim();
    }
  }

  return inputs;
}

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

export function resolveMockFixtureToken(prompt: BootstrapPrompt): string | null {
  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => getPromptContentText(message.content))
    .join("\n");
  // The current turn's user batch participates last so instruction- and
  // skill-delivered fixture directives always win. Scanning user text makes
  // per-turn context (clientContext entries, channel context strings) and
  // exact-reply prompts deterministically provable in smoke evals. Only the
  // trailing user messages count: directives from earlier turns must not
  // leak into later replies.
  const searchableTexts = [
    ...getLoadedSkillResultTexts(prompt),
    systemText,
    getTrailingUserText(prompt),
  ];

  for (const text of searchableTexts) {
    const fixtureReply = resolveExactFixtureReply(text);
    if (fixtureReply !== null) return fixtureReply;
  }

  return null;
}

export function resolveWeatherCity(message: string): string {
  const invocationJsonCityMatch = /"city"\s*:\s*"([^"]+)"/u.exec(message);

  if (invocationJsonCityMatch?.[1]) {
    return invocationJsonCityMatch[1].trim();
  }

  const cityMatch =
    /\b(?:in|for)\s+([A-Za-z][A-Za-z\s.-]*?)(?:[?.!,]|$)/u.exec(message) ??
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/u.exec(message);

  return cityMatch?.[1]?.trim() || "Brooklyn";
}

export function formatToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Joined text of the user messages at the tail of the prompt (the current turn's batch). */
function getTrailingUserText(prompt: BootstrapPrompt): string {
  const texts: string[] = [];

  for (const message of [...prompt].reverse()) {
    if (message.role === "system") continue;
    if (message.role !== "user") break;
    texts.unshift(getPromptContentText(message.content));
  }

  return texts.join("\n");
}

function getLoadedSkillResultTexts(prompt: BootstrapPrompt): string[] {
  return prompt.flatMap((message) => {
    if (message.role !== "tool" && message.role !== "assistant") {
      return [];
    }

    const parts = typeof message.content === "string" ? [message.content] : message.content;

    return parts.flatMap((part) => {
      if (typeof part === "string" || part.type !== "tool-result") {
        return [];
      }

      if (part.toolName !== LOAD_SKILL_TOOL_NAME || part.output.type === "execution-denied") {
        return [];
      }

      return [formatToolOutput(part.output.value)];
    });
  });
}

function resolveExactFixtureReply(text: string): string | null {
  const exactString = matchExactValue(
    /\breply\s+with\s+the\s+exact\s+string\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s.]+))\s+and\s+nothing\s+else\b/iu,
    text,
  );
  if (exactString !== null) {
    return exactString;
  }

  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const inlineBlockMatch =
      /\breply\s+with\s+exactly(?:\s+the\s+following\s+text\s+and\s+nothing\s+else)?:\s*(.+)$/iu.exec(
        line,
      );
    if (inlineBlockMatch?.[1]) {
      return cleanExactValue(inlineBlockMatch[1]);
    }

    if (
      /\breply\s+with\s+exactly\s+the\s+following\s+text\s+and\s+nothing\s+else:\s*$/iu.test(
        line,
      ) ||
      /\breply\s+with\s+exactly:\s*$/iu.test(line)
    ) {
      const nextLine = lines
        .slice(index + 1)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0);
      if (nextLine !== undefined) {
        return cleanExactValue(nextLine);
      }
    }
  }

  return matchExactValue(
    /\binclude\s+the\s+exact\s+token\s+(`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s.]+))\s+verbatim\b/iu,
    text,
  );
}

function matchExactValue(pattern: RegExp, text: string): string | null {
  const match = pattern.exec(text);
  if (match === null) return null;

  return cleanExactValue(match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[1] ?? "");
}

function cleanExactValue(value: string): string {
  return value.trim();
}

function getToolInputPropertyNames(schema: unknown): readonly string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }

  return Object.keys(schema.properties);
}

function hasProperties(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((property) => actual.includes(property));
}

function createAskQuestionInput(message: string): Record<string, unknown> {
  const options = parseInputOptions(message);
  const input: Record<string, unknown> = {
    prompt: resolveQuestionPrompt(message),
  };

  if (options.length > 0) {
    input.options = options;
  }

  if (/\ballow\s*freeform\s+(?:to\s+)?true\b|\ballowfreeform\s+(?:to\s+)?true\b/iu.test(message)) {
    input.allowFreeform = true;
  }

  return input;
}

function parseInputOptions(message: string): Array<{ id: string; label: string }> {
  return [...message.matchAll(/\bid\b\s*:?\s*"([^"]+)"\s*,\s*label\b\s*:?\s*"([^"]+)"/giu)].map(
    (match) => ({
      id: match[1] ?? "",
      label: match[2] ?? "",
    }),
  );
}

function resolveQuestionPrompt(message: string): string {
  const quotedPrompt =
    /\b(?:set\s+)?prompt\s+to:\s*'([^']+)'/iu.exec(message) ??
    /\b(?:set\s+)?prompt\s+to:\s*"([^"]+)"/iu.exec(message);
  if (quotedPrompt?.[1]) {
    return quotedPrompt[1].trim();
  }

  const askMatch = /\bask(?:\s+me)?\s+(?:to\s+)?(.+?)(?:\.|$)/iu.exec(message);
  return askMatch?.[1]?.trim() || "Please choose an option.";
}

function resolveShellCommand(message: string): string {
  const backtickMatch = /`([^`]+)`/u.exec(message);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }

  const quotedCommand =
    /\b(?:run|command)\s+["']([^"']+)["']/iu.exec(message) ??
    /\bcommand\s+(.+?)(?:\.|$)/iu.exec(message);

  return quotedCommand?.[1]?.trim() || "pwd";
}

function resolveLookupTopic(message: string): string {
  const topicMatch = /\btopic\s+['"]?([A-Za-z0-9_.-]+)['"]?/u.exec(message);
  return topicMatch?.[1] ?? "demo";
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
