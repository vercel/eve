import type { EveMessagePart, EveToolPart } from "#client/message-types.js";

export function isTerminalToolCallPart(part: EveMessagePart): part is EveToolPart {
  return part.type === "tool" && part.kind === "tool";
}
