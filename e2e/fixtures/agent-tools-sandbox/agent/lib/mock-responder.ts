import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { OVERFLOW_PROBE_TOKEN } from "./overflow-probe.js";

const SUBAGENT_DIRECTIVE = /ask the `([^`]+)` subagent with message:\s*([\s\S]+)/iu;
const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;
const SKILL_DIRECTIVE = /load the `([^`]+)` skill/iu;

const OVERFLOW_DIRECTIVE = /run the `overflow_probe` tool/iu;
const OVERFLOW_FILE_PATH = /^\/workspace\/\.eve\/tool-results\/[a-f0-9]{64}\.json$/u;
/**
 * Scripted mock for the world suites: sandbox evals phrase every prompt as an
 * explicit directive, so the responder executes exactly the requested tool
 * and replies from its output. Turn state derives from the prompt: a tool
 * message after the latest user message means this turn's call already ran.
 */
export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  let lastAuthoredUserIndex = -1;
  let lastToolResultIndex = -1;
  for (let index = 0; index < request.messages.length; index += 1) {
    const entry = request.messages[index]!;
    if (entry.role === "tool") lastToolResultIndex = index;
    if (entry.role === "user" && !entry.text.trim().startsWith("[Agents]")) {
      lastAuthoredUserIndex = index;
    }
  }
  const turnHasToolResult = lastToolResultIndex > lastAuthoredUserIndex;
  if (OVERFLOW_DIRECTIVE.test(message)) {
    return overflowProbeResponse(request);
  }

  const subagent = SUBAGENT_DIRECTIVE.exec(message);
  if (subagent?.[1] !== undefined && subagent[2] !== undefined) {
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { message: subagent[2] }, name: subagent[1] }] };
    }
    return toolOutput(request, subagent[1]);
  }

  const bash = BASH_DIRECTIVE.exec(message);
  if (bash?.[1] !== undefined) {
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { command: bash[1] }, name: "bash" }] };
    }
    if (/reply with the single word:\s*done/iu.test(message)) {
      return "done";
    }
    return bashStdout(request);
  }

  const skill = SKILL_DIRECTIVE.exec(message);
  if (skill?.[1] !== undefined) {
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { skill: skill[1] }, name: "load_skill" }] };
    }
    // Loaded skills instruct an exact reply whose text is the skill body's
    // final line (see the redeploy eval's deploy-note skill).
    return lastNonEmptyLine(toolOutput(request, "load_skill"));
  }

  return `Mock reply: ${message}`;
}

function overflowProbeResponse(request: MockModelRequest): MockModelResponse | string {
  const probe = request.toolResults.find((result) => result.id === "overflow-probe-source");
  if (probe === undefined) {
    return {
      toolCalls: [{ id: "overflow-probe-source", input: {}, name: "overflow_probe" }],
    };
  }

  if (request.toolResults.some((result) => result.id === "overflow-probe-read")) {
    return bashStdout(request);
  }

  const path = overflowFilePath(probe.output);
  if (path === undefined) {
    return "overflow_probe did not produce an eve tool-output file reference";
  }

  return {
    toolCalls: [
      {
        id: "overflow-probe-read",
        input: { command: `grep -m 1 -o '${OVERFLOW_PROBE_TOKEN}' ${path}` },
        name: "bash",
      },
    ],
  };
}

function overflowFilePath(output: unknown): string | undefined {
  if (
    typeof output !== "object" ||
    output === null ||
    !("kind" in output) ||
    output.kind !== "eve-tool-output-file" ||
    !("bytes" in output) ||
    typeof output.bytes !== "number" ||
    output.bytes <= 64 * 1024 ||
    !("toolName" in output) ||
    output.toolName !== "overflow_probe" ||
    !("path" in output) ||
    typeof output.path !== "string" ||
    !OVERFLOW_FILE_PATH.test(output.path)
  ) {
    return undefined;
  }
  return output.path;
}

function bashStdout(request: MockModelRequest): string {
  const output = [...request.toolResults]
    .reverse()
    .find((result) => result.name === "bash")?.output;
  if (typeof output === "object" && output !== null && "stdout" in output) {
    return String((output as { stdout: unknown }).stdout).trim();
  }
  return formatOutput(output);
}

function toolOutput(request: MockModelRequest, name: string): string {
  const output = [...request.toolResults].reverse().find((result) => result.name === name)?.output;
  return formatOutput(output);
}

function formatOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? text;
}
