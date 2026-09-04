import type { MockModelRequest, MockModelResponse } from "eve/evals";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (!message.includes("schema replay regression")) return `Mock reply: ${message}`;
  if (request.tools.some((tool) => tool.name === "invalid_dynamic_schema")) {
    throw new Error("A dynamic schema with an unsupported transformation reached the model.");
  }

  const value = message.includes("whitespace") ? " " : "  accepted  ";
  const id = `schema-replay-${request.userMessageCount}`;
  if (request.toolResults.some((result) => result.id === id)) return "Schema replay checked.";
  return { toolCalls: [{ id, name: "normalize_dynamic", input: { value } }] };
}
