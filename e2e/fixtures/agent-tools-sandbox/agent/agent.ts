import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;
const SKILL_DIRECTIVE = /load the `([^`]+)` skill/iu;

/**
 * Scripted mock for the world suites: sandbox evals phrase every prompt as an
 * explicit directive, so the responder executes exactly the requested tool
 * and replies from its output. Turn state derives from the prompt: a tool
 * message after the latest user message means this turn's call already ran.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const roles = request.messages.map((entry) => entry.role);
  const turnHasToolResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");

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
    return lastNonEmptyLine(formatOutput(request.toolResults.at(-1)?.output));
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

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
