import type {
  GenerateTextOnStepStartCallback,
  LanguageModelUsage,
  ModelMessage,
  PrepareStepFunction,
  ProviderMetadata,
  StepResult,
  ToolSet,
  ToolResultPart,
} from "ai";
import { usageOf } from "#harness/facts.js";
import { createRuntimeToolResultFromMessagePart } from "#harness/action-result-helpers.js";
import { toJsonValue } from "#harness/call-facts.js";
import { settleCall } from "#harness/session-machine/calls.js";
import { settleRun } from "#harness/session-machine/runs.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import { normalizeAssistantStepFinishReason } from "#harness/finish-reason.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { ModelProfile } from "#harness/model-profile.js";
import {
  applyConversationCacheControl,
  mergeGatewayAutoCaching,
  omitGatewayAutoCaching,
} from "#harness/prompt-cache.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";
import { type HarnessEmitFn, type HarnessSession } from "#harness/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";

export type HarnessStepResult = Pick<
  StepResult<ToolSet>,
  | "content"
  | "finishReason"
  | "providerMetadata"
  | "response"
  | "text"
  | "toolCalls"
  | "toolResults"
  | "usage"
> & {
  readonly callId?: string;
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
  readonly approvalRequests?: readonly ApprovalAsk[];
  readonly policyApprovals?: Readonly<Record<string, import("#harness/clearance.js").Clearance>>;
  readonly signIns?: readonly ToolSignIn[];
};

interface StepHooksInput {
  readonly auth?: import("#channel/types.js").SessionAuthContext | null;
  readonly model: RuntimeModelReference;
  readonly profile: ModelProfile;
  readonly startStep?: (messages: readonly ModelMessage[]) => Promise<void>;
  readonly session: HarnessSession;
}

interface StepHooks {
  readonly onStepStart: GenerateTextOnStepStartCallback<ToolSet>;

  readonly onStepEnd: (step: StepResult<ToolSet>) => Promise<void>;

  readonly prepareStep: PrepareStepFunction<ToolSet>;

  readonly stepResult: Promise<HarnessStepResult>;
}

export function buildStepHooks(input: StepHooksInput): StepHooks {
  const session = input.session;

  let resolveStep: (step: HarnessStepResult) => void;
  const stepResult = new Promise<HarnessStepResult>((resolve) => {
    resolveStep = resolve;
  });

  const prepareStep: PrepareStepFunction<ToolSet> = async ({ messages }) => {
    const { profile } = input;
    const stepResult: NonNullable<Awaited<ReturnType<PrepareStepFunction<ToolSet>>>> = {
      messages: profile.anthropicCache
        ? applyConversationCacheControl(messages, profile.anthropicCache)
        : messages,
    };

    const providerOptions = resolveCallProviderOptions({
      auth: input.auth ?? contextStorage.getStore()?.get(AuthKey) ?? null,
      profile,
      providerOptions: input.model.providerOptions,
      session,
    });
    if (profile.gateway && profile.anthropicCache === undefined) {
      stepResult.providerOptions = mergeGatewayAutoCaching(
        providerOptions,
        profile.provider,
      ) as NonNullable<typeof stepResult.providerOptions>;
    } else if (providerOptions !== undefined) {
      stepResult.providerOptions = (
        profile.gateway ? omitGatewayAutoCaching(providerOptions) : providerOptions
      ) as NonNullable<typeof stepResult.providerOptions>;
    }

    return stepResult;
  };

  const onStepStart: GenerateTextOnStepStartCallback<ToolSet> = async ({ messages }) => {
    await input.startStep?.(messages);
  };

  return {
    onStepEnd: async (step: StepResult<ToolSet>): Promise<void> => {
      resolveStep(step);
    },
    onStepStart,
    prepareStep,
    stepResult,
  };
}

export async function emitStepActions(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  step: HarnessStepResult,
  notRun: readonly ToolResultPart[],
): Promise<void> {
  const { runId } = state;
  for (const part of notRun) {
    await emitFn(settleCall(createRuntimeToolResultFromMessagePart(part, part.toolName)));
  }
  if (runId === undefined) return;
  const result = finalOutputOf(step);
  await emitFn(
    settleRun(
      {
        finishReason: normalizeAssistantStepFinishReason(step.finishReason),
        generationId: readGatewayGenerationId(step.providerMetadata),
        outcome: "completed",
        runId,
        usage: runUsageOf({
          costUsd: extractGatewayCostUsd(step.providerMetadata),
          usage: step.usage,
        }),
      },
      result === undefined
        ? undefined
        : {
            kind: "result",
            partId: `${runId}.result`,
            phase: "reply",
            runId,
            value: result,
          },
    ),
  );
}

function finalOutputOf(step: HarnessStepResult) {
  const call = (step.toolCalls ?? []).find(
    (candidate) => candidate.toolName === REPLY_TOOL_NAME && !isInvalidToolCall(candidate),
  );
  return call === undefined ? undefined : toJsonValue(call.input);
}

export function runUsageOf(input: {
  readonly costUsd: number | undefined;
  readonly usage: LanguageModelUsage | undefined;
}): Usage | undefined {
  const { usage } = input;
  if (usage === undefined && input.costUsd === undefined) return undefined;
  return usageOf({
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    costUsd: input.costUsd,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  });
}

export function extractGatewayCostUsd(
  providerMetadata: ProviderMetadata | undefined,
): number | undefined {
  const gateway = readGatewayMetadata(providerMetadata);
  const cost = gateway?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = Number(cost);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readGatewayGenerationId(
  providerMetadata: ProviderMetadata | undefined,
): string | undefined {
  const generationId = readGatewayMetadata(providerMetadata)?.generationId;
  return typeof generationId === "string" && generationId.length > 0 ? generationId : undefined;
}

function readGatewayMetadata(
  providerMetadata: ProviderMetadata | undefined,
): ProviderMetadata[string] | undefined {
  const gateway = providerMetadata?.gateway;
  return gateway && typeof gateway === "object" && !Array.isArray(gateway) ? gateway : undefined;
}
