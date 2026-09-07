import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import {
  isCurrentDynamicToolMetadata,
  type CurrentDynamicToolMetadata,
  type PersistedDynamicToolMetadata,
} from "#context/dynamic-tool-metadata.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createLogger } from "#internal/logging.js";
import type {
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "#approval/definition.js";
import {
  callDurableDynamicCallback,
  lookupDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
} from "#tools/durable-callbacks.js";
import { toInputSchema, toOutputSchema } from "#tools/schema.js";
import { getDynamicToolSchemas } from "#context/dynamic-tool-schemas.js";

const log = createLogger("dynamic-tools");

function missingCallbackError(
  metadata: CurrentDynamicToolMetadata,
  phase: DurableDynamicCallbackPhase,
): Error {
  return new Error(
    `Dynamic tool "${metadata.name}" cannot replay its ${phase} callback because it is not ` +
      "registered in this process. The tool was removed or renamed since this call was parked, " +
      "or its resolver did not run. Restore the tool definition or start a new session.",
  );
}

function buildReplayedApproval(
  metadata: CurrentDynamicToolMetadata,
): HarnessToolDefinition["approval"] | undefined {
  const requestReference = metadata.callbacks.approvalRequest;
  if (requestReference === undefined) return undefined;

  const request = lookupDurableDynamicCallback(metadata.name, "approvalRequest");
  const requestPolicy =
    request === undefined
      ? async () => {
          log.error(missingCallbackError(metadata, "approvalRequest").message);
          return "user-approval" as const;
        }
      : async (context: ApprovalContext) =>
          (await callDurableDynamicCallback(
            request,
            requestReference.closure,
            context,
          )) as ApprovalStatus;

  const responseReference = metadata.callbacks.approvalResponse;
  if (responseReference === undefined) return requestPolicy;

  const response = lookupDurableDynamicCallback(metadata.name, "approvalResponse");
  return {
    request: requestPolicy,
    response:
      response === undefined
        ? async () => {
            const error = missingCallbackError(metadata, "approvalResponse");
            log.error(error.message);
            return {
              reason: error.message,
              status: "rejected" as const,
            };
          }
        : async (context: ApprovalResponseContext) =>
            (await callDurableDynamicCallback(
              response,
              responseReference.closure,
              context,
            )) as ApprovalResponseDecision,
  };
}

/** Reconstructs every callback exclusively from its durable descriptor. */
export function replayDynamicTools(
  metadata: readonly CurrentDynamicToolMetadata[],
): HarnessToolDefinition[] {
  return metadata.map((entry) => {
    const schemas = getDynamicToolSchemas(entry);
    const approvalKeyReference = entry.callbacks.approvalKey;
    const approvalKey =
      approvalKeyReference === undefined
        ? undefined
        : lookupDurableDynamicCallback(entry.name, "approvalKey");
    const executeReference = entry.callbacks.execute;
    const execute = lookupDurableDynamicCallback(entry.name, "execute");
    const toModelOutputReference = entry.callbacks.toModelOutput;
    const toModelOutput =
      toModelOutputReference === undefined
        ? undefined
        : lookupDurableDynamicCallback(entry.name, "toModelOutput");

    return {
      description: entry.description,
      execute:
        entry.execution === "background"
          ? createToolExecuteWithAuth({
              execution: "background",
              scope: entry.name,
              execute: (input, context, task) => {
                if (execute === undefined) {
                  throw missingCallbackError(entry, "execute");
                }
                return callDurableDynamicCallback(
                  execute,
                  executeReference.closure,
                  input,
                  context,
                  task,
                );
              },
            })
          : createToolExecuteWithAuth({
              scope: entry.name,
              execute: (input, context) => {
                if (execute === undefined) {
                  throw missingCallbackError(entry, "execute");
                }
                return callDurableDynamicCallback(
                  execute,
                  executeReference.closure,
                  input,
                  context,
                );
              },
            }),
      inputSchema: schemas.input ?? toInputSchema(entry.inputSchema),
      name: entry.name,
      execution: entry.execution,
      approval: buildReplayedApproval(entry),
      ...(approvalKeyReference === undefined
        ? {}
        : {
            approvalKey: (input: Readonly<Record<string, unknown>>) => {
              if (approvalKey === undefined) {
                throw missingCallbackError(entry, "approvalKey");
              }
              const key = callDurableDynamicCallback(
                approvalKey,
                approvalKeyReference.closure,
                input,
              );
              if (typeof key !== "string") {
                throw new Error(
                  `Dynamic tool "${entry.name}" approvalKey callback must return a string.`,
                );
              }
              return key;
            },
          }),
      outputSchema: schemas.output ?? toOutputSchema(entry.outputSchema),
      ...(toModelOutputReference === undefined
        ? {}
        : {
            toModelOutput: (output: unknown) => {
              if (toModelOutput === undefined) {
                throw missingCallbackError(entry, "toModelOutput");
              }
              return callDurableDynamicCallback(
                toModelOutput!,
                toModelOutputReference.closure,
                output,
              );
            },
          }),
    };
  });
}

function requireCurrentDynamicToolMetadata(
  metadata: readonly PersistedDynamicToolMetadata[],
): readonly CurrentDynamicToolMetadata[] {
  const old = metadata.find((entry) => !isCurrentDynamicToolMetadata(entry));
  if (old !== undefined) {
    throw new Error(
      `Dynamic tool "${old.name}" reached replay before its persisted metadata was converted to the current schema.`,
    );
  }
  return metadata as readonly CurrentDynamicToolMetadata[];
}

/**
 * Builds live dynamic tool definitions. Narrower scopes appear first so they
 * win on name collision (the tool loop uses `??=` for deduplication).
 */
export function buildResponseAuthorizationTools(input: {
  readonly authoredTools: HarnessToolMap;
  readonly context?: ContextReader;
}): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const tool of input.context === undefined ? [] : buildDynamicTools(input.context)) {
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  }
  for (const [name, tool] of input.authoredTools) {
    if (!tools.has(name)) tools.set(name, tool);
  }
  return tools;
}

export function buildDynamicTools(ctx: ContextReader): readonly HarnessToolDefinition[] {
  const step = replayDynamicTools(
    requireCurrentDynamicToolMetadata(ctx.get(StepDynamicToolMetadataKey) ?? []),
  );
  const turn = replayDynamicTools(
    requireCurrentDynamicToolMetadata(ctx.get(TurnDynamicToolMetadataKey) ?? []),
  );
  const session = replayDynamicTools(
    requireCurrentDynamicToolMetadata(ctx.get(SessionDynamicToolMetadataKey) ?? []),
  );
  return [...step, ...turn, ...session];
}
