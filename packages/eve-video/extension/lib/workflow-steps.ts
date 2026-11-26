import type { WorkflowStepToolContext } from "eve/tools";
import { FatalError, type WorkflowWebhookRequest } from "eve/workflow";

import extension from "../extension.ts";
import {
  checkAndPersistToolVideoJob,
  cleanupStoredKeys,
  isTransientProviderError,
  submitToolVideoJob,
  type CheckAndPersistStepResult,
  type SubmitVideoStepResult,
} from "./engine.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import type { GenerateVideoToolInput, VideoJobHandle } from "./types.ts";
import { verifyAndRespondWebhook } from "./webhook.ts";

export type { CheckAndPersistStepResult, SubmitVideoStepResult };

export async function submitVideoStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrlCandidate?: string,
): Promise<SubmitVideoStepResult> {
  "use step";
  try {
    return await submitToolVideoJob(extension.config, input, ctx, webhookUrlCandidate);
  } catch (error) {
    if (ctx.abortSignal.aborted || error instanceof FatalError || isTransientProviderError(error)) {
      throw error;
    }
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
}

export async function verifyAndRespondWebhookStep(
  request: WorkflowWebhookRequest,
  secret: string,
): Promise<boolean> {
  "use step";
  return verifyAndRespondWebhook(request, secret);
}

export async function checkAndPersistStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  handle: VideoJobHandle,
): Promise<CheckAndPersistStepResult> {
  "use step";
  try {
    return await checkAndPersistToolVideoJob(extension.config, input, ctx, handle);
  } catch (error) {
    if (ctx.abortSignal.aborted || error instanceof FatalError || isTransientProviderError(error)) {
      throw error;
    }
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
}

export async function cleanupStagedInputsStep(stagedInputKeys: readonly string[]): Promise<void> {
  "use step";
  if (stagedInputKeys.length === 0) return;
  await cleanupStoredKeys(resolveConfiguredStorage(extension.config.storage), stagedInputKeys);
}
