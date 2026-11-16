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
 * Matcher for a `research` call's output: at least one finding came back.
 *
 * @param value - The `output` of a completed `research` call.
 * @returns True when `findings` is a non-empty array.
 */
export const hasFindings = (value: unknown): boolean => {
  const { findings } = asRecord(value);
  return Array.isArray(findings) && findings.length > 0;
};

/**
 * Build the message that makes the offline mock model call one tool.
 *
 * @remarks
 * The mock root model (`agent/lib/mock-model.ts`) reads a JSON `{ tool, input }` message as an
 * instruction to call that tool, then replies with the tool results as JSON.
 *
 * @param tool - The tool to call.
 * @param input - The tool input.
 * @returns The message to send to the agent.
 */
export const toolScript = (tool: string, input: unknown): string =>
  JSON.stringify({ input, tool });
