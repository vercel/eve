type ToolOutputSerializationBoundary = "action.result" | "execute" | "toModelOutput";

export class ToolOutputSerializationError extends TypeError {
  readonly toolCallId: string | undefined;
  readonly toolName: string;

  constructor(input: {
    readonly boundary: ToolOutputSerializationBoundary;
    readonly cause?: unknown;
    readonly toolCallId?: string;
    readonly toolName: string;
  }) {
    super(formatToolOutputSerializationMessage(input));
    this.name = "ToolOutputSerializationError";
    this.toolCallId = input.toolCallId;
    this.toolName = input.toolName;
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

function formatToolOutputSerializationMessage(input: {
  readonly boundary: ToolOutputSerializationBoundary;
  readonly cause?: unknown;
  readonly toolCallId?: string;
  readonly toolName: string;
}): string {
  const subject =
    input.toolCallId === undefined
      ? `Tool "${input.toolName}"`
      : `Tool "${input.toolName}" call "${input.toolCallId}"`;
  const action =
    input.boundary === "execute"
      ? "returned a non-JSON-serializable result"
      : input.boundary === "toModelOutput"
        ? "returned a non-JSON-serializable model output"
        : "produced a non-JSON-serializable action result";
  const detail =
    input.cause instanceof Error && input.cause.message.length > 0 ? ` ${input.cause.message}` : "";

  return `${subject} ${action}.${detail}`;
}

export function withToolOutputSerializationError<T>(
  input: {
    readonly boundary: ToolOutputSerializationBoundary;
    readonly toolCallId?: string;
    readonly toolName: string;
  },
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ToolOutputSerializationError) {
      throw error;
    }
    throw new ToolOutputSerializationError({
      boundary: input.boundary,
      cause: error,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    });
  }
}
