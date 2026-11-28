import type { WorkflowStepToolContext } from "eve/tools";
import { FatalError, type WorkflowWebhookRequest } from "eve/workflow";

import extension from "../extension.ts";
import * as engine from "./engine.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import type { GenerateVideoToolInput, VideoJobHandle } from "./types.ts";
import { verifyAndRespondWebhook } from "./webhook.ts";

export type { CheckAndPersistStepResult, SubmitVideoStepResult } from "./engine.ts";

export async function submitVideoStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrl?: string,
): Promise<engine.SubmitVideoStepResult> {
  "use step";
  try {
    return await engine.submitToolVideoJob(extension.config, input, ctx, webhookUrl);
  } catch (err) {
    if (
      ctx.abortSignal.aborted ||
      err instanceof FatalError ||
      engine.isTransientProviderError(err)
    )
      throw err;
    throw new FatalError(err instanceof Error ? err.message : String(err));
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
): Promise<engine.CheckAndPersistStepResult> {
  "use step";
  try {
    return await engine.checkAndPersistToolVideoJob(extension.config, input, ctx, handle);
  } catch (err) {
    if (
      ctx.abortSignal.aborted ||
      err instanceof FatalError ||
      engine.isTransientProviderError(err)
    )
      throw err;
    throw new FatalError(err instanceof Error ? err.message : String(err));
  }
}

export async function cleanupStagedInputsStep(stagedInputKeys: readonly string[]): Promise<void> {
  "use step";
  if (stagedInputKeys.length)
    await engine.cleanupStoredKeys(
      resolveConfiguredStorage(extension.config.storage),
      stagedInputKeys,
    );
}
