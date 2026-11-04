import type { ScopeRecord } from "./types.js";
import type { ContentSerializer } from "./types.js";
import { capturedScopeData } from "./span-kinds.js";
const SERIALIZED_BYTES = 256 * 1024;
const SNAPSHOT_BYTES = 512 * 1024;
const UNFINISHED_CHILDREN = 10000;
import { preservingCapturePolicy, withoutDeclinedContent } from "./content-policy.js";

const TRUNCATION_MARKER = "… [truncated]";
const TURN_CONTENT_ATTRIBUTES = ["gen_ai.input.messages", "gen_ai.output.messages"] as const;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Text of a serialized GenAI message's text parts, the truncatable content. */
function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.content !== "string") continue;
    text += (text.length === 0 ? "" : "\n") + record.content;
  }
  return text;
}

/**
 * Shrinks a serialized GenAI message array to `budgetBytes` while keeping it
 * valid JSON: the newest message's text is truncated with the library's
 * truncation marker, mirroring how the serializer caps oversized prompts.
 * The cut is binary searched, so an attribute far over the budget costs a
 * logarithmic number of encodes instead of re-encoding a near-full candidate
 * at every step.
 */
function fitTurnContent(input: string, budgetBytes: number): string | undefined {
  if (budgetBytes <= 0) return undefined;
  if (byteLength(input) <= budgetBytes) return input;
  let messages: unknown;
  try {
    messages = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last = messages.at(-1);
  if (typeof last !== "object" || last === null) return undefined;
  const message = last as Record<string, unknown>;
  if (typeof message.role !== "string") return undefined;
  const text = messageText(message.parts);
  const base =
    typeof message.kind === "string"
      ? { kind: message.kind, role: message.role }
      : { role: message.role };
  const candidate = (length: number): string =>
    JSON.stringify([
      {
        ...base,
        parts: [{ content: `${text.slice(0, length)}${TRUNCATION_MARKER}`, type: "text" }],
      },
    ]);
  let best: string | undefined;
  let low = 1;
  let high = text.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const probe = candidate(middle);
    if (byteLength(probe) <= budgetBytes) {
      best = probe;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) return best;
  const minimal = candidate(0);
  return byteLength(minimal) <= budgetBytes ? minimal : undefined;
}

/**
 * Adds truncated copies of the turn's content attributes back into a stripped
 * checkpoint, sized so the whole record stays within the snapshot budgets. A
 * copy that cannot fit small enough is left out; the capture-policy attributes
 * stay truthful either way.
 */
function withFittedTurnContent(
  attributes: Record<string, unknown>,
  original: Readonly<Record<string, unknown>>,
  record: ScopeRecord,
): Record<string, unknown> {
  let fitted = attributes;
  for (const key of TURN_CONTENT_ATTRIBUTES) {
    const value = original[key];
    if (typeof value !== "string") continue;
    const withoutKey = { ...fitted };
    delete withoutKey[key];
    const bare = { ...record, attributes: withoutKey } as ScopeRecord;
    let budget = Math.min(
      SERIALIZED_BYTES - byteLength(JSON.stringify(bare.data)),
      SNAPSHOT_BYTES - nodeBytes(bare),
    );
    while (budget > 0) {
      const truncated = fitTurnContent(value, budget);
      // Shrinking the budget cannot help when even the minimal form does not
      // fit or the copy is not truncatable JSON.
      if (truncated === undefined) break;
      const candidate = { ...fitted, [key]: truncated };
      if (nodeBytes({ ...record, attributes: candidate } as ScopeRecord) <= SNAPSHOT_BYTES) {
        fitted = candidate;
        break;
      }
      budget = Math.floor(budget / 2);
    }
  }
  return fitted;
}

import type { TraceSnapshot } from "./types.js";
export function boundedSerializer(
  serializer: ContentSerializer,
  onError?: import("./types.js").TraceErrorHandler,
): ContentSerializer {
  function invoke(method: keyof ContentSerializer, args: unknown[]): string | undefined {
    return bounded(() => Reflect.apply(serializer[method], serializer, args) as string | undefined);
  }
  function bounded(serialize: () => string | undefined): string | undefined {
    try {
      const value = serialize();
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
    inputMessages: (value) => {
      let omitted = 0;
      const json = bounded(() => {
        const content = serializer.inputMessages(value);
        omitted = content?.omitted ?? 0;
        return content?.json;
      });
      return json === undefined ? undefined : { json, omitted };
    },
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
    const declined = {
      emit: record.capture.emit,
      recordInputs: false,
      recordOutputs: false,
    };
    let structural = capturedScopeData(data, declined);
    if (structural.type === "step")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    if (structural.type === "model")
      structural = { ...structural, options: { ...structural.options, runtimeContext: undefined } };
    // A size-driven strip is not a capture-policy decline: the policy
    // attributes keep the record's real decision, and the turn's content
    // attributes stay as truncated copies when they fit the node budget.
    const original = record.attributes ?? {};
    const attributes = withFittedTurnContent(
      preservingCapturePolicy(withoutDeclinedContent(original, declined) ?? {}, original),
      original,
      { ...record, version: 1, data: structural },
    );
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
        attributes,
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
