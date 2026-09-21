import type { MockModelRequest, MockModelResponse } from "eve/evals";

const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const command = BASH_DIRECTIVE.exec(message)?.[1];
  const result = [...request.toolResults].reverse().at(0);
  if (result !== undefined) {
    if (typeof result.output === "object" && result.output !== null && "stdout" in result.output)
      return String((result.output as { readonly stdout: unknown }).stdout).trim();
    return "done";
  }
  if (command !== undefined) return { toolCalls: [{ input: { command }, name: "bash" }] };
  return `Mock reply: ${message}`;
}
