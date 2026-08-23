import type { MockModelRequest, MockModelResponse } from "eve/evals";

const SUBAGENT_DIRECTIVE = /ask the `([^`]+)` subagent with message:\s*([\s\S]+)/iu;
const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;
const SKILL_DIRECTIVE = /load the `([^`]+)` skill/iu;
const USE_TOOL_DIRECTIVE = /use the `([^`]+)` tool/iu;

/**
 * Scripted mock for the world suites: sandbox evals phrase every prompt as an
 * explicit directive, so the responder executes exactly the requested tool
 * and replies from its output. Turn state derives from the prompt: a tool
 * message after the latest user message means this turn's call already ran.
 */
export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const roles = request.messages.map((entry) => entry.role);
  const turnHasToolResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");

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

  const useTool = USE_TOOL_DIRECTIVE.exec(message);
  if (useTool?.[1] !== undefined) {
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: {}, name: useTool[1] }] };
    }
    return toolOutput(request, useTool[1]);
  }

  return `Mock reply: ${message}`;
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
