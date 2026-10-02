import type { MockModelRequest, MockModelResponse } from "eve/evals";

const BASH_DIRECTIVE = /run the bash command `([^`]+)`/iu;

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const command = BASH_DIRECTIVE.exec(message)?.[1];
  if (command === undefined) return `Mock reply: ${message}`;

  const result = [...request.toolResults].reverse().find(({ name }) => name === "bash");
  if (result === undefined) {
    return { toolCalls: [{ input: { command }, name: "bash" }] };
  }
  if (typeof result.output === "object" && result.output !== null && "stdout" in result.output) {
    return String((result.output as { readonly stdout: unknown }).stdout).trim();
  }
  return String(result.output ?? "");
}
