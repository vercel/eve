import { createSpanWriter } from "#tracing/lib/index.js";
import {
  requestAttributes,
  requestStatusAttributes,
  channelRequestMetadata,
  mcpAttributes,
  mcpName,
  applyAttributes,
  SPAN_NAMES,
} from "#tracing/lib/index.js";
import { mcpLifecycle, intersectCapture, runTraceContext } from "#tracing/lib/index.js";
import type {
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
  ActiveOperation,
  ContentSerializer,
} from "#tracing/lib/index.js";

export function createTransportLifecycle(
  backend: Pick<TraceBackend, "start" | "run" | "current" | "active" | "suppressed">,
  serializer: ContentSerializer,
) {
  const engine = createSpanWriter({ backend });
  return {
    active: () => backend.active?.(),
    request(input: {
      method: string;
      route: string;
      scheme?: string;
      serverAddress?: string;
      parent?: TraceReference;
      executionContext?: ExecutionContext;
    }) {
      const operation = engine.start(
        {
          type: "channelRequest",
          operationId: `${input.method} ${input.route}`,
          name: SPAN_NAMES.channelRequest,
          kind: "SERVER",
          parent: input.parent,
          attributes: requestAttributes(input),
        },
        { emit: true, recordInputs: false, recordOutputs: false },
        input.executionContext,
      );
      return {
        reference: operation.reference,
        run<T>(execute: () => T) {
          return runTraceContext(
            backend,
            operation.reference,
            operation.capture,
            execute,
            input.executionContext,
            { type: "channelRequest", reference: operation.reference, capture: operation.capture },
          );
        },
        channel(input: { channelName?: string; channelKind?: string }) {
          applyAttributes(operation, channelRequestMetadata(input));
        },
        completed(status: number) {
          applyAttributes(operation, requestStatusAttributes(status));
          if (status >= 500) operation.setStatus("ERROR");
          operation.end();
        },
        failed() {
          operation.setStatus("ERROR");
          operation.end();
        },
      };
    },
    mcp(input: {
      method: "tools/list" | "tools/call";
      connectionName: string;
      toolName?: string;
      protocolVersion?: string;
      parent?: TraceReference;
      executionContext?: ExecutionContext;
      capture: CaptureDecision;
    }) {
      input = { ...input, capture: intersectCapture(input.capture, backend.active?.()?.capture) };
      const operation = engine.start(
        {
          type: "mcp",
          operationId: `${input.connectionName}:${input.method}`,
          name: mcpName(input.method, input.toolName),
          kind: "CLIENT",
          parent: input.parent,
          attributes: mcpAttributes(input),
        },
        input.capture,
        input.executionContext,
      );
      const semantic = mcpLifecycle({
        serializer,
        ...input.capture,
        write: (attributes) => applyAttributes(operation, attributes),
        error: operation.fail,
      });
      const active: ActiveOperation = {
        type: "mcp",
        reference: operation.reference,
        capture: input.capture,
        mcp: semantic,
      };
      return {
        reference: operation.reference,
        run<T>(execute: () => T) {
          return runTraceContext(
            backend,
            operation.reference,
            input.capture,
            execute,
            input.executionContext,
            active,
          );
        },
        ...semantic,
        completed(result?: unknown) {
          if (result !== undefined) semantic.result(result);
          operation.end();
        },
        failed(error?: unknown, type?: string) {
          semantic.error(error, type);
          operation.end();
        },
        end: operation.end,
      };
    },
  };
}
