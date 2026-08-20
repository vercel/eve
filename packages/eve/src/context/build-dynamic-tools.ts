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
import type { DurableDynamicCallbackReference } from "#shared/durable-dynamic-tool-callbacks.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");

function lookupStepFunction(stepId: string): ((...args: unknown[]) => unknown) | null {
  const registry = (globalThis as Record<symbol, Map<string, Function> | undefined>)[
    Symbol.for("@workflow/core//registeredSteps")
  ];
  const callback = registry?.get(stepId);
  return callback ? (callback as (...args: unknown[]) => unknown) : null;
}

function missingCallbackError(
  metadata: DurableDynamicToolMetadata,
  phase: keyof DurableDynamicToolMetadata["callbacks"],
  reference: DurableDynamicCallbackReference,
): Error {
  return new Error(
    `Dynamic tool "${metadata.name}" cannot replay its ${phase} callback because ` +
      `step function "${reference.stepId}" is not registered. Rebuild the agent and ensure ` +
      "the callback is created at module scope or transformed from authored source.",
  );
}

function buildReplayedApproval(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["approval"] | undefined {
  const requestReference = metadata.callbacks.approvalRequest;
  if (requestReference === undefined) return undefined;

  const request = lookupStepFunction(requestReference.stepId);
  const requestPolicy =
    request === null
      ? async () => {
          log.error(missingCallbackError(metadata, "approvalRequest", requestReference).message);
          return "user-approval" as const;
        }
      : async (context: ApprovalContext) =>
          (await request(requestReference.closure, context)) as ApprovalStatus;

  const responseReference = metadata.callbacks.approvalResponse;
  if (responseReference === undefined) return requestPolicy;

  const response = lookupStepFunction(responseReference.stepId);
  return {
    request: requestPolicy,
    response:
      response === null
        ? async () => {
            const error = missingCallbackError(metadata, "approvalResponse", responseReference);
            log.error(error.message);
            return {
              reason: error.message,
              status: "rejected" as const,
            };
          }
        : async (context: ApprovalResponseContext) =>
            (await response(responseReference.closure, context)) as ApprovalResponseDecision,
  };
}

/** Reconstructs every callback exclusively from its durable descriptor. */
export function replayDynamicTools(
  metadata: readonly DurableDynamicToolMetadata[],
): HarnessToolDefinition[] {
  return metadata.map((entry) => {
    const executeReference = entry.callbacks.execute;
    const execute = lookupStepFunction(executeReference.stepId);
    const toModelOutputReference = entry.callbacks.toModelOutput;
    const toModelOutput =
      toModelOutputReference === undefined
        ? undefined
        : lookupStepFunction(toModelOutputReference.stepId);

    return {
      description: entry.description,
      execute: createToolExecuteWithAuth({
        scope: entry.name,
        execute: (input, context) => {
          if (execute === null) {
            throw missingCallbackError(entry, "execute", executeReference);
          }
          return execute(executeReference.closure, input, context);
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
              if (toModelOutput === null) {
                throw missingCallbackError(entry, "toModelOutput", toModelOutputReference);
              }
              return toModelOutput!(toModelOutputReference.closure, output);
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
  const step = replayDynamicTools(ctx.get(StepDynamicToolMetadataKey) ?? []);
  const turn = replayDynamicTools(ctx.get(TurnDynamicToolMetadataKey) ?? []);
  const session = replayDynamicTools(ctx.get(SessionDynamicToolMetadataKey) ?? []);
  return [...step, ...turn, ...session];
}
