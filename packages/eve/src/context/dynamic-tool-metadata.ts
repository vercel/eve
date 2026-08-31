import type { JsonObject } from "#shared/json.js";
import type { DurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";

interface DynamicToolMetadataBase {
  readonly name: string;
  readonly description: string;
  readonly execution?: "background";
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

export function isOldSourceOffsetDynamicToolMetadata(
  metadata: PersistedDynamicToolMetadata,
): metadata is OldSourceOffsetDynamicToolMetadata {
  return metadata.callbacks !== undefined && "stepId" in metadata.callbacks.execute;
}

export function isCurrentDynamicToolMetadata(
  metadata: PersistedDynamicToolMetadata,
): metadata is CurrentDynamicToolMetadata {
  return metadata.callbacks !== undefined && !isOldSourceOffsetDynamicToolMetadata(metadata);
}

export function isOldStepFunctionDynamicToolMetadata(
  metadata: PersistedDynamicToolMetadata,
): metadata is OldStepFunctionDynamicToolMetadata {
  return metadata.callbacks === undefined;
}

function withoutSourceOffset(
  reference: OldSourceOffsetDynamicCallbackReference,
): DurableDynamicToolCallbacks["execute"] {
  return { closure: reference.closure };
}

function convertSourceOffsetMetadata(
  metadata: OldSourceOffsetDynamicToolMetadata,
): CurrentDynamicToolMetadata {
  const callbacks: DurableDynamicToolCallbacks = {
    execute: withoutSourceOffset(metadata.callbacks.execute),
    ...(metadata.callbacks.approvalRequest === undefined
      ? {}
      : { approvalRequest: withoutSourceOffset(metadata.callbacks.approvalRequest) }),
    ...(metadata.callbacks.approvalResponse === undefined
      ? {}
      : { approvalResponse: withoutSourceOffset(metadata.callbacks.approvalResponse) }),
    ...(metadata.callbacks.toModelOutput === undefined
      ? {}
      : { toModelOutput: withoutSourceOffset(metadata.callbacks.toModelOutput) }),
  };
  return { ...metadata, callbacks };
}

/** Converts persisted metadata without changing already-persisted callback closures. */
export function toCurrentDynamicToolMetadata(
  persisted: PersistedDynamicToolMetadata,
  resolved?: CurrentDynamicToolMetadata,
): CurrentDynamicToolMetadata {
  if (isCurrentDynamicToolMetadata(persisted)) return persisted;
  if (resolved === undefined) {
    throw new Error(
      `Dynamic tool "${persisted.name}" uses old persisted metadata, but its resolver did not return a current replacement.`,
    );
  }
  if (resolved.resolverSlug !== persisted.resolverSlug || resolved.name !== persisted.name) {
    throw new Error(
      `Dynamic tool "${persisted.name}" received current metadata from a different resolver or tool.`,
    );
  }
  if (!isOldStepFunctionDynamicToolMetadata(persisted)) {
    for (const phase of Object.keys(persisted.callbacks) as Array<
      keyof DurableDynamicToolCallbacks
    >) {
      if (resolved.callbacks[phase] === undefined) {
        throw new Error(
          `Dynamic tool "${persisted.name}" lost its ${phase} callback while converting old persisted metadata.`,
        );
      }
    }
    return convertSourceOffsetMetadata(persisted);
  }
  if (
    persisted.approvalResponseStepFnName !== undefined &&
    persisted.approvalStepFnName === undefined
  ) {
    throw new Error(
      `Dynamic tool "${persisted.name}" has an old approval-response callback without an approval-request callback.`,
    );
  }
  if (
    persisted.approvalStepFnName !== undefined &&
    resolved.callbacks.approvalRequest === undefined
  ) {
    throw new Error(
      `Dynamic tool "${persisted.name}" lost its approval-request callback while converting old persisted metadata.`,
    );
  }
  if (
    persisted.approvalResponseStepFnName !== undefined &&
    resolved.callbacks.approvalResponse === undefined
  ) {
    throw new Error(
      `Dynamic tool "${persisted.name}" lost its approval-response callback while converting old persisted metadata.`,
    );
  }
  return resolved;
}

export function toCurrentDynamicToolMetadataList(
  persisted: readonly PersistedDynamicToolMetadata[],
  resolved: readonly CurrentDynamicToolMetadata[] = [],
): readonly CurrentDynamicToolMetadata[] {
  return persisted.map((entry) =>
    toCurrentDynamicToolMetadata(
      entry,
      resolved.find(
        (candidate) =>
          candidate.resolverSlug === entry.resolverSlug && candidate.name === entry.name,
      ),
    ),
  );
}
