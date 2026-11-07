import { isConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { createLogger, logError } from "#internal/logging.js";
import { buildConnectionCallbackContext } from "#runtime/connections/approval-scope.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { ModelFacingError } from "#shared/model-facing-error.js";

const log = createLogger("runtime.connections.tool-error");

/**
 * The error a failed connection tool call rethrows: the original, or a {@link ModelFacingError}
 * carrying the text the connection's `toolCall.onError` chose. Sign-in requests pass through, since
 * eve answers them itself. Call it inside the call's approval scope, which the handler's context reads.
 */
export async function connectionToolError(
  connection: ResolvedConnectionDefinition,
  error: unknown,
  call: { readonly callId: string; readonly toolName: string },
): Promise<unknown> {
  const onError = connection.toolCall?.onError;
  if (onError === undefined || isConnectionAuthorizationRequiredError(error)) return error;
  let text: string | undefined;
  try {
    text = await onError(error, { ...buildConnectionCallbackContext(), ...call });
  } catch (handlerError) {
    logError(log, "connection toolCall.onError failed; the model reads the default", handlerError, {
      connectionName: connection.connectionName,
      toolName: call.toolName,
    });
    return error;
  }
  return typeof text === "string" ? new ModelFacingError(text, { cause: error }) : error;
}
