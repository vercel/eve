import type {
  CodeModeInterrupt,
  CodeModeInterruptExecutionContext,
  CodeModeInterruptPayload,
} from "#shared/code-mode.js";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { JsonValue } from "#public/types/json.js";
import { isObject } from "#shared/guards.js";

export const CODE_MODE_CONNECTION_AUTH_INTERRUPT_KIND = "eve.connection-auth";

export interface CodeModeConnectionAuthPayload extends CodeModeInterruptPayload {
  readonly kind: typeof CODE_MODE_CONNECTION_AUTH_INTERRUPT_KIND;
  readonly args: JsonValue;
  readonly challenges?: readonly AuthorizationChallenge[];
  readonly connectionName: string;
  readonly toolName: string;
}

export type CodeModeConnectionAuthResolution =
  | {
      readonly status: "authorized";
    }
  | {
      readonly reason: string;
      readonly retryable: boolean;
      readonly status: "failed";
    };

export type CodeModeConnectionAuthContext = CodeModeInterruptExecutionContext<
  CodeModeConnectionAuthPayload,
  CodeModeConnectionAuthResolution
>;

const CODE_MODE_TOOL_EXECUTION_FLAG = "__eveCodeMode";

export function markCodeModeToolExecutionOptions(options: unknown): unknown {
  if (!isObject(options)) {
    return { [CODE_MODE_TOOL_EXECUTION_FLAG]: true };
  }

  return {
    ...options,
    [CODE_MODE_TOOL_EXECUTION_FLAG]: true,
  };
}

export function isCodeModeToolExecutionOptions(options: unknown): boolean {
  return isObject(options) && options[CODE_MODE_TOOL_EXECUTION_FLAG] === true;
}

export function readCodeModeConnectionAuthContext(
  options: unknown,
): CodeModeConnectionAuthContext | undefined {
  if (!isObject(options)) return undefined;
  const codeModeInterrupt = options.codeModeInterrupt;
  if (!isObject(codeModeInterrupt)) return undefined;
  if (!isCodeModeConnectionAuthPayload(codeModeInterrupt.payload)) return undefined;
  if (!isCodeModeConnectionAuthResolution(codeModeInterrupt.resolution)) return undefined;
  if (typeof codeModeInterrupt.interruptId !== "string") return undefined;
  return {
    interruptId: codeModeInterrupt.interruptId,
    payload: codeModeInterrupt.payload,
    resolution: codeModeInterrupt.resolution,
  };
}

export function isCodeModeConnectionAuthPayload(
  value: unknown,
): value is CodeModeConnectionAuthPayload {
  return (
    isObject(value) &&
    value.kind === CODE_MODE_CONNECTION_AUTH_INTERRUPT_KIND &&
    typeof value.connectionName === "string" &&
    typeof value.toolName === "string" &&
    "args" in value
  );
}

export function isCodeModeConnectionAuthInterrupt(
  value: unknown,
): value is CodeModeInterrupt<CodeModeConnectionAuthPayload> {
  if (!isObject(value) || value.type !== "code-mode-interrupt") {
    return false;
  }

  return isCodeModeConnectionAuthPayload(value.payload);
}

export function toConnectionAuthResolutionFailure(input: {
  readonly reason: string;
  readonly retryable: boolean;
}): CodeModeConnectionAuthResolution {
  return {
    reason: input.reason,
    retryable: input.retryable,
    status: "failed",
  };
}

export function toCodeModeConnectionAuthArgs(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function isCodeModeConnectionAuthResolution(
  value: unknown,
): value is CodeModeConnectionAuthResolution {
  if (!isObject(value) || typeof value.status !== "string") return false;
  if (value.status === "authorized") return true;
  return (
    value.status === "failed" &&
    typeof value.reason === "string" &&
    typeof value.retryable === "boolean"
  );
}
