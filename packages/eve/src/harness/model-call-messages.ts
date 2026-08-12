import type { ModelMessage, ToolResultPart } from "ai";

/**
 * Rewrites `execution-denied` tool-result outputs to `error-text` for
 * consumption by language-model providers.
 *
 * The `execution-denied` marker is an eve-internal shape persisted in
 * session history so that `action.result` projection can surface a
 * structured `{ code: "TOOL_EXECUTION_DENIED", message }` payload. AI SDK
 * provider adapters, however, only recognise `text | error-text | json |
 * error-json | content` as `ToolResultOutput`; an `execution-denied`
 * output reaches the provider's prompt-conversion path unrecognised and
 * some providers (notably OpenAI) reject the resumed request with
 * `Missing required parameter: 'input[N].output'`.
 *
 * This helper is the single boundary where persisted history is
 * down-projected for a model call. When no rewrite is needed the input
 * array is returned by reference; when a rewrite is needed a new array
 * is allocated — the input is never mutated, so session history
 * retains the `execution-denied` marker for UI and telemetry consumers.
 */
export function materializeExecutionDeniedToolResultsForModel(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const rewrittenMessages: ModelMessage[] = [];
  let didRewrite = false;

  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content === "string") {
      rewrittenMessages.push(message);
      continue;
    }

    const rewrittenContent = rewriteToolContent(message.content);
    if (rewrittenContent === null) {
      rewrittenMessages.push(message);
      continue;
    }

    didRewrite = true;
    rewrittenMessages.push({ ...message, content: rewrittenContent });
  }

  return didRewrite ? rewrittenMessages : (messages as ModelMessage[]);
}

type ToolContentPart = Extract<ModelMessage, { role: "tool" }>["content"] extends string
  ? never
  : Extract<ModelMessage, { role: "tool" }>["content"] extends ReadonlyArray<infer P>
    ? P
    : never;

/**
 * Returns `null` when nothing needed rewriting so callers can keep the
 * original array reference (no GC pressure on the happy path).
 */
function rewriteToolContent(parts: unknown): ToolContentPart[] | null {
  if (!Array.isArray(parts)) {
    return null;
  }

  let rewritten: ToolContentPart[] | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "tool-result" &&
      isExecutionDeniedOutput((part as ToolResultPart).output)
    ) {
      const deniedReason = ((part as ToolResultPart).output as DeniedOutput).reason;
      const replacement: ToolResultPart = {
        output: { type: "error-text", value: executionDeniedToErrorText(deniedReason) },
        toolCallId: (part as ToolResultPart).toolCallId,
        toolName: (part as ToolResultPart).toolName,
        type: "tool-result",
      };
      if (rewritten === null) {
        rewritten = (parts as ToolContentPart[]).slice(0, i);
      }
      rewritten.push(replacement);
      continue;
    }

    if (rewritten !== null) {
      rewritten.push(part as ToolContentPart);
    }
  }

  return rewritten;
}

type DeniedOutput = { readonly type: "execution-denied"; readonly reason?: string };

function isExecutionDeniedOutput(output: unknown): output is DeniedOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "execution-denied"
  );
}

function executionDeniedToErrorText(reason: string | undefined): string {
  return reason === undefined || reason.length === 0
    ? "Tool execution was denied."
    : `Tool execution was denied: ${reason}`;
}
