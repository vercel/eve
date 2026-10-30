import { toolOutput, type ToolModelOutput } from "#public/tools/index.js";

/** What a provided tool returns when a new message stops it early. */
export interface InterruptedOutput {
  readonly interrupted: true;
}

const INTERRUPTED_TEXT = "Stopped early because a new message arrived.";

/** The model sees an interrupted call as text and every other output as JSON, as it would by default. */
export function toInterruptibleModelOutput(output: object): ToolModelOutput {
  if ("interrupted" in output) return toolOutput.text(INTERRUPTED_TEXT);
  return toolOutput.json(output);
}

export const INTERRUPTED_OUTPUT_SCHEMA = {
  type: "object",
  properties: { interrupted: { type: "boolean", const: true } },
  required: ["interrupted"],
  additionalProperties: false,
} as const;
