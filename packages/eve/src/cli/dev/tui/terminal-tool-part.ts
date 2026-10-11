import type { EveDynamicToolPart, EveMessagePart } from "#client/message-reducer-types.js";

export function isTerminalToolCallPart(part: EveMessagePart): part is EveDynamicToolPart {
  return part.type === "dynamic-tool" && part.toolMetadata?.eve?.kind === "tool-call";
}
