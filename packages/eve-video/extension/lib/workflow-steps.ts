import type { WorkflowStepToolContext } from "eve/tools";
import type { WorkflowWebhookRequest } from "eve/workflow";

import type { GenerateVideoToolInput, VideoJobHandle } from "./types.ts";
import {
  runCheckAndPersistStep,
  runCleanupStagedInputsStep,
  runSubmitVideoStep,
  runVerifyAndRespondWebhookStep,
  type CheckAndPersistStepResult,
  type SubmitVideoStepResult,
} from "./workflow-step-impl.ts";

export type { CheckAndPersistStepResult, SubmitVideoStepResult } from "./workflow-step-impl.ts";

export async function submitVideoStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrlCandidate?: string,
): Promise<SubmitVideoStepResult> {
  "use step";
  return runSubmitVideoStep(input, ctx, webhookUrlCandidate);
}

export async function verifyAndRespondWebhookStep(
  request: WorkflowWebhookRequest,
  secret: string,
): Promise<boolean> {
  "use step";
  return runVerifyAndRespondWebhookStep(request, secret);
}

export async function checkAndPersistStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  handle: VideoJobHandle,
): Promise<CheckAndPersistStepResult> {
  "use step";
  return runCheckAndPersistStep(input, ctx, handle);
}

export async function cleanupStagedInputsStep(stagedInputKeys: readonly string[]): Promise<void> {
  "use step";
  return runCleanupStagedInputsStep(stagedInputKeys);
}
