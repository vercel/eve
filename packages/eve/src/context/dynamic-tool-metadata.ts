import type { JsonObject } from "#shared/json.js";
import type { DurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";

interface DynamicToolMetadataBase {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly resolverSlug: string;
  readonly entryKey: string;
}

/** Current schema: callback identity is the surrounding tool name and phase. */
export interface CurrentDynamicToolMetadata extends DynamicToolMetadataBase {
  readonly callbacks: DurableDynamicToolCallbacks;
}

/** Old schema written before callback descriptors existed. */
export interface OldStepFunctionDynamicToolMetadata extends DynamicToolMetadataBase {
  readonly callbacks?: never;
  readonly executeStepFnName?: string;
  readonly approvalStepFnName?: string;
  readonly approvalResponseStepFnName?: string;
  readonly closureVars?: Record<string, unknown>;
}

interface OldSourceOffsetDynamicCallbackReference {
  readonly closure: JsonObject;
  readonly stepId: string;
}

/** Old schema whose callback identity was a generated source offset. */
export interface OldSourceOffsetDynamicToolMetadata extends DynamicToolMetadataBase {
  readonly callbacks: {
    readonly execute: OldSourceOffsetDynamicCallbackReference;
    readonly approvalRequest?: OldSourceOffsetDynamicCallbackReference;
    readonly approvalResponse?: OldSourceOffsetDynamicCallbackReference;
    readonly toModelOutput?: OldSourceOffsetDynamicCallbackReference;
  };
}

export type OldDynamicToolMetadata =
  | OldStepFunctionDynamicToolMetadata
  | OldSourceOffsetDynamicToolMetadata;

export type PersistedDynamicToolMetadata = CurrentDynamicToolMetadata | OldDynamicToolMetadata;

export function isCurrentDynamicToolMetadata(
  metadata: PersistedDynamicToolMetadata,
): metadata is CurrentDynamicToolMetadata {
  return metadata.callbacks !== undefined && !("stepId" in metadata.callbacks.execute);
}

/** Replaces an old payload with current output from the same resolver and tool identity. */
export function toCurrentDynamicToolMetadata(
  persisted: PersistedDynamicToolMetadata,
  resolved: CurrentDynamicToolMetadata | undefined,
): CurrentDynamicToolMetadata {
  if (isCurrentDynamicToolMetadata(persisted)) return persisted;
  if (resolved !== undefined) return resolved;
  throw new Error(
    `Dynamic tool "${persisted.name}" uses old persisted metadata, but its resolver did not return a current replacement.`,
  );
}
