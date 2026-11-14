/**
 * Read a tool call's input or output as a plain record, whatever form the event stream uses.
 *
 * @param value - A tool call's `input` or `output`, as passed to a `calledTool` matcher.
 * @returns The value as a record, or an empty record when it isn't an object or JSON object.
 */
export const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

/**
 * Build the message that makes an offline mock model call one tool.
 *
 * @remarks
 * The mock model (`agent/lib/mock-model/config.ts`) reads a JSON `{ tool, input }` message as an
 * instruction to call that tool, then replies with the tool results as JSON. Every agent runs the
 * same mock offline, so a script sent to a specialist as its `message` makes the specialist call
 * one of its own tools.
 *
 * @param tool - The tool to call.
 * @param input - The tool input.
 * @returns The message to send to the agent.
 */
export const toolScript = (tool: string, input: unknown): string =>
  JSON.stringify({ input, tool });
