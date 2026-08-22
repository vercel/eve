import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createLogger } from "#internal/logging.js";
import type {
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "#public/definitions/approval.js";
import {
  callDurableDynamicCallback,
  lookupDurableDynamicCallback,
  type DurableDynamicCallbackPhase,
} from "#shared/durable-dynamic-tool-callbacks.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");

function missingCallbackError(
  metadata: DurableDynamicToolMetadata,
  phase: DurableDynamicCallbackPhase,
): Error {
  return new Error(
    `Dynamic tool "${metadata.name}" cannot replay its ${phase} callback because it is not ` +
      "registered in this process. The tool was removed or renamed since this call was parked, " +
      "or its resolver did not run. Restore the tool definition or start a new session.",
  );
}

function buildReplayedApproval(
  metadata: DurableDynamicToolMetadata,
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
  metadata: readonly DurableDynamicToolMetadata[],
): HarnessToolDefinition[] {
  return metadata.map((entry) => {
    const executeReference = entry.callbacks.execute;
    const execute = lookupDurableDynamicCallback(entry.name, "execute");
    const toModelOutputReference = entry.callbacks.toModelOutput;
    const toModelOutput =
      toModelOutputReference === undefined
        ? undefined
        : lookupDurableDynamicCallback(entry.name, "toModelOutput");

    return {
      description: entry.description,
      execute: createToolExecuteWithAuth({
        scope: entry.name,
        execute: (input, context) => {
          if (execute === undefined) {
            throw missingCallbackError(entry, "execute");
          }
          return callDurableDynamicCallback(execute, executeReference.closure, input, context);
        },
      }),
      inputSchema: toInputSchema(entry.inputSchema),
      name: entry.name,
      approval: buildReplayedApproval(entry),
      outputSchema: toOutputSchema(entry.outputSchema),
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

/**
 * Builds live dynamic tool definitions. Narrower scopes appear first so they
 * win on name collision (the tool loop uses `??=` for deduplication).
 */
export function buildResponseAuthorizationTools(input: {
  readonly authoredTools: HarnessToolMap;
  readonly context?: ContextReader;
  readonly reservedToolNames?: ReadonlySet<string>;
}): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const tool of input.context === undefined
    ? []
    : buildDynamicTools(input.context, input.reservedToolNames)) {
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  }
  for (const [name, tool] of input.authoredTools) {
    if (!tools.has(name)) tools.set(name, tool);
  }
  return tools;
}

export function buildDynamicTools(
  ctx: ContextReader,
  reservedToolNames: ReadonlySet<string> = new Set(),
): readonly HarnessToolDefinition[] {
  const step = replayDynamicTools(ctx.get(StepDynamicToolMetadataKey) ?? []);
  const turn = replayDynamicTools(ctx.get(TurnDynamicToolMetadataKey) ?? []);
  const session = replayDynamicTools(ctx.get(SessionDynamicToolMetadataKey) ?? []);
  const tools = [...step, ...turn, ...session];
  const collision = tools.find((tool) => reservedToolNames.has(tool.name));
  if (collision !== undefined) {
    throw new Error(`Dynamic tool "${collision.name}" collides with a native kernel capability.`);
  }
  return tools;
}
