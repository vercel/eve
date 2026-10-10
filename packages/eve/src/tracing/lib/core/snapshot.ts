import type { ScopeRecord } from "./types.js";
import type { ContentSerializer } from "./types.js";
import { capturedScopeData } from "./span-kinds.js";
const SERIALIZED_BYTES = 32768;
const SNAPSHOT_BYTES = 65536;
const UNFINISHED_CHILDREN = 10000;
import { withoutDeclinedContent } from "./content-policy.js";

import type { TraceSnapshot } from "./types.js";
export function boundedSerializer(
  serializer: ContentSerializer,
  onError?: import("./types.js").TraceErrorHandler,
): ContentSerializer {
  function invoke(method: keyof ContentSerializer, args: unknown[]): string | undefined {
    try {
      const value = Reflect.apply(serializer[method], serializer, args) as string | undefined;
      return value === undefined || new TextEncoder().encode(value).length > SERIALIZED_BYTES
        ? undefined
        : value;
    } catch (error) {
      try {
        onError?.(error, { phase: "serialize" });
      } catch {}
      return undefined;
    }
  }
  return {
    json: (value) => invoke("json", [value]),
    text: (value) => invoke("text", [value]),
    inputMessages: (value) => invoke("inputMessages", [value]),
    instructions: (value) => invoke("instructions", [value]),
    toolDefinitions: (value) => invoke("toolDefinitions", [value]),
    outputMessages: (value, reason) => invoke("outputMessages", [value, reason]),
    toolResults: (value) => invoke("toolResults", [value]),
  };
}

/** Each node is capped on its own; settled children leave the tree. */
function nodeBytes(record: ScopeRecord): number {
  return new TextEncoder().encode(JSON.stringify({ ...record, children: undefined })).length;
}

export function traceSnapshot(value: unknown): TraceSnapshot {
  return JSON.parse(JSON.stringify(value)) as TraceSnapshot;
}

export function validSnapshot(
  value: unknown,
  maxBytes: number = SNAPSHOT_BYTES,
  depth = 0,
): value is ScopeRecord {
  try {
    if (depth > 16) return false;
    if (typeof value !== "object" || value === null) return false;
    const record = value as ScopeRecord;
    if (
      record.children !== undefined &&
      (!Array.isArray(record.children) ||
        record.children.length > UNFINISHED_CHILDREN ||
        !record.children.every((child) => validSnapshot(child, maxBytes, depth + 1)))
    )
      return false;
    if (record.version !== 1) return false;
    if (record.finished !== undefined && typeof record.finished !== "boolean") return false;
    if (
      record.childSequence !== undefined &&
      (!Number.isSafeInteger(record.childSequence) || record.childSequence < 0)
    )
      return false;
    if (
      typeof record.key !== "string" ||
      typeof record.startTimeMs !== "number" ||
      !Number.isFinite(record.startTimeMs)
    )
      return false;
    if (record.reference.traceFlags !== 0 && record.reference.traceFlags !== 1) return false;
    if (
      record.reference.tracestate !== undefined &&
      (typeof record.reference.tracestate !== "string" || record.reference.tracestate.length > 512)
    )
      return false;
    if (
      record.parent !== undefined &&
      (!/^[a-f0-9]{32}$/u.test(record.parent.traceId) ||
        !/^[a-f0-9]{16}$/u.test(record.parent.spanId))
    )
      return false;
    if (
      ![record.identity.conversationId, record.identity.runId, record.identity.turnId].every(
        (v) => typeof v === "string",
      )
    )
      return false;
    const options = record.data.options as Record<string, unknown>;
    const fields = {
      activation: [],
      step: [],
      model: ["provider", "modelId"],
      tool: ["callId", "name"],
      approval: ["requestId", "callId", "toolName"],
      memory: ["operation", "phase", "slot", "storeId"],
    };
    if (!fields[record.data.type].every((key) => typeof options[key] === "string")) return false;
    if (record.data.type === "activation" && !Number.isSafeInteger(options.sequence)) return false;
    if (record.data.type === "step" && !Number.isSafeInteger(options.index)) return false;
    if (
      record.data.type === "memory" &&
      options.operation !== "search_memory" &&
      options.operation !== "upsert_memory"
    )
      return false;
    if (
      !/^[a-f0-9]{32}$/u.test(record.reference.traceId) ||
      !/^[a-f0-9]{16}$/u.test(record.reference.spanId) ||
      typeof record.reference.traceFlags !== "number"
    )
      return false;
    if (
      ![record.capture.emit, record.capture.recordInputs, record.capture.recordOutputs].every(
        (v) => typeof v === "boolean",
      )
    )
      return false;
    if (
      !["activation", "step", "model", "tool", "approval", "memory"].includes(record.data.type) ||
      typeof record.data.options !== "object" ||
      record.data.options === null
    )
      return false;
    if (nodeBytes(record) > maxBytes) return false;
    return true;
  } catch {
    return false;
  }
}

export function snapshotRecord(record: ScopeRecord, serializer: ContentSerializer): ScopeRecord {
  const terminal = record.terminal;
  record = {
    ...record,
    children: record.children?.map((child) =>
      snapshotRecord(
        {
          ...child,
          capture: {
            emit: child.capture.emit && record.capture.emit,
            recordInputs: child.capture.recordInputs && record.capture.recordInputs,
            recordOutputs: child.capture.recordOutputs && record.capture.recordOutputs,
          },
        },
        serializer,
      ),
    ),
  };
  record = {
    ...record,
    terminal:
      terminal === undefined || record.finished
        ? undefined
        : {
            ...terminal,
            errorCode:
              terminal.errorCode ??
              (terminal.error instanceof Error ? terminal.error.name : undefined),
            error: record.capture.recordOutputs
              ? terminal.error instanceof Error
                ? { name: terminal.error.name, message: serializer.text(terminal.error.message) }
                : terminal.error
              : undefined,
            output: record.capture.recordOutputs ? terminal.output : undefined,
            response: record.capture.recordOutputs ? terminal.response : undefined,
            records: record.capture.recordInputs ? terminal.records : undefined,
            model:
              terminal.model === undefined
                ? undefined
                : {
                    ...terminal.model,
                    content: record.capture.recordOutputs ? terminal.model.content : undefined,
                  },
          },
  };
  record = {
    ...record,
    attributes: (withoutDeclinedContent(record.attributes ?? {}, record.capture) ??
      record.attributes) as ScopeRecord["attributes"],
  };
  const data = capturedScopeData(record.data, record.capture);
  let json: string | undefined;
  try {
    json = serializer.json(data);
  } catch {}
  const fallback = () => {
    let structural = capturedScopeData(data, {
      emit: record.capture.emit,
      recordInputs: false,
      recordOutputs: false,
    });
    if (structural.type === "step")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    if (structural.type === "model")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    return JSON.parse(
      JSON.stringify({
        ...record,
        version: 1,
        data: structural,
        terminal:
          record.terminal === undefined
            ? undefined
            : {
                outcome: record.terminal.outcome,
                failed: record.terminal.failed,
                errorCode: record.terminal.errorCode,
                usage: record.terminal.usage,
              },
        attributes:
          withoutDeclinedContent(record.attributes ?? {}, {
            recordInputs: false,
            recordOutputs: false,
          }) ?? record.attributes,
      }),
    ) as ScopeRecord;
  };
  if (json === undefined || new TextEncoder().encode(json).length > SERIALIZED_BYTES)
    return fallback();
  try {
    const snapshot = JSON.parse(
      JSON.stringify({ ...record, version: 1, data: JSON.parse(json) }),
    ) as ScopeRecord;
    return nodeBytes(snapshot) <= SNAPSHOT_BYTES ? snapshot : fallback();
  } catch {
    return fallback();
  }
}
