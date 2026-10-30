import type { ActiveOperation, CaptureDecision } from "./types.js";

export function intersectCapture(
  capture: CaptureDecision,
  ceiling?: CaptureDecision,
): CaptureDecision {
  const emit = capture.emit && (ceiling?.emit ?? true);
  return {
    emit,
    recordInputs: emit && capture.recordInputs && (ceiling?.recordInputs ?? true),
    recordOutputs: emit && capture.recordOutputs && (ceiling?.recordOutputs ?? true),
  };
}

export function activeOperation(
  operation: ActiveOperation,
  capture: CaptureDecision,
): ActiveOperation {
  const mcp = operation.mcp;
  return {
    type: operation.type,
    reference: operation.reference,
    capture,
    mcp:
      mcp === undefined
        ? undefined
        : {
            update: (input) => mcp.update(input),
            error: (error, type) =>
              mcp.error(
                capture.recordOutputs ? error : undefined,
                type ?? (error instanceof Error ? error.name : undefined),
              ),
            arguments: (value) => {
              if (capture.recordInputs) mcp.arguments(value);
            },
            result: (value) => {
              if (capture.recordOutputs) mcp.result(value);
            },
          },
  };
}
