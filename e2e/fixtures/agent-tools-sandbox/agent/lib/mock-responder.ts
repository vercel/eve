import type { MockModelRequest, MockModelResponse } from "eve/evals";

const SUBAGENT_DIRECTIVE = /ask the `([^`]+)` subagent with message:\s*([\s\S]+)/iu;
const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;
const SKILL_DIRECTIVE = /load the `([^`]+)` skill/iu;

/**
 * Scripted mock for the world suites: sandbox evals phrase every prompt as an
 * explicit directive, so the responder executes exactly the requested tool
 * and replies from its output. Turn state derives from the prompt: a tool
 * message after the latest user message means this turn's call already ran.
 */
export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("EVE_SANDBOX_CURL_FANOUT")) {
    return request.toolResults.some((result) => result.name === "bash")
      ? "curl fanout complete"
      : {
          toolCalls: [...message.matchAll(/^curl-\d+: `([^`]+)`$/gmu)].map(([, command]) => ({
            input: { command },
            name: "bash",
          })),
        };
  }
  if (message.includes("EVE_SANDBOX_BASH_JOB")) {
    return respondToBashJob(message, request);
  }
  if (message.includes("DYNAMIC-TURN-REPLAY-START")) {
    const gate = request.toolResults.find((result) => result.name === "dynamic-turn-replay-gate");
    if (gate === undefined) {
      return { toolCalls: [{ input: {}, name: "dynamic-turn-replay-gate" }] };
    }
    const probe = request.toolResults.find((result) => result.name === "dynamic_turn_replay_probe");
    return probe === undefined
      ? { toolCalls: [{ input: {}, name: "dynamic_turn_replay_probe" }] }
      : formatOutput(probe.output);
  }

  let lastAuthoredUserIndex = -1;
  let lastToolResultIndex = -1;
  for (let index = 0; index < request.messages.length; index += 1) {
    const entry = request.messages[index]!;
    if (entry.role === "tool") lastToolResultIndex = index;
    if (entry.role === "user" && !isFrameworkMessage(entry.text)) {
      lastAuthoredUserIndex = index;
    }
  }
  const turnHasToolResult = lastToolResultIndex > lastAuthoredUserIndex;

  const subagent = SUBAGENT_DIRECTIVE.exec(message);
  if (subagent?.[1] !== undefined && subagent[2] !== undefined) {
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { message: subagent[2] }, name: subagent[1] }] };
    }
    // The agent call returned a receipt; its result arrives in a <task_result> message.
    return (
      taskResultOf(request, subagent[1]) ?? { toolCalls: [{ input: {}, name: "eve__task_wait" }] }
    );
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
      return { toolCalls: [{ input: { skill: skill[1] }, name: "eve__execute" }] };
    }
    // Loaded skills instruct an exact reply whose text is the skill body's
    // final line (see the redeploy eval's deploy-note skill).
    return lastNonEmptyLine(toolOutput(request, "eve__execute"));
  }

  return `Mock reply: ${message}`;
}

/** Starts the slow command, reads its output once, stops it, then replies. */
function respondToBashJob(message: string, request: MockModelRequest): MockModelResponse | string {
  const outputs = request.toolResults
    .filter((result) => result.name === "bash")
    .map(
      (result) => result.output as { readonly outputDirectory?: unknown; readonly pid?: unknown },
    );
  if (outputs.length === 0) {
    const command = /by running: `([^`]+)`/u.exec(message)?.[1] ?? "";
    return { toolCalls: [{ input: { command }, name: "bash" }] };
  }
  const { outputDirectory, pid } = outputs[0] ?? {};
  if (typeof outputDirectory !== "string" || typeof pid !== "number") {
    return formatOutput(outputs[0]);
  }
  if (outputs.length === 1) {
    const command = `sleep 2; tail -n 1 ${outputDirectory}/stdout`;
    return { toolCalls: [{ input: { command }, name: "bash" }] };
  }
  if (outputs.length === 2) {
    const exitFile = `${outputDirectory}/exit`;
    const command = `kill -- -${pid}; for i in 1 2 3 4 5; do [ -f ${exitFile} ] && break; sleep 1; done; cat ${exitFile}`;
    return { toolCalls: [{ input: { command }, name: "bash" }] };
  }
  return "index job stopped";
}

/** The `[Tasks]` note and `<task_result>` messages are eve's, not the user's. */
function isFrameworkMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("[Tasks]") || trimmed.startsWith("<task_result");
}

function taskResultOf(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(`<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`);
  for (const entry of [...request.messages].reverse()) {
    if (entry.role !== "user") continue;
    const body = entry.text.match(pattern)?.[1];
    if (body !== undefined) return body;
  }
  return undefined;
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
