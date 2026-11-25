import { gateway, type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";

import type { KernelConfig } from "#harness/types.js";
import type { ModelChoice } from "#definitions/model.js";
import type { RuntimeModel } from "#runtime/agent/resolve-model.js";
import { evaluateStepModel, stepModel, type ValueRun } from "#definitions/step.js";
import type { Step } from "#harness/step/context.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { appendPackageUserAgent } from "#internal/user-agent.js";

export function buildGatewayAttributionHeaders(
  profile: ModelProfile,
  runtimeIdentity: KernelConfig["runtimeIdentity"],
): Record<string, string> | undefined {
  if (!profile.gateway) return undefined;

  const title = runtimeIdentity?.agentName ?? runtimeIdentity?.agentId;
  const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const referer = deploymentHost ? `https://${deploymentHost}` : undefined;

  const headers: Record<string, string> = Object.fromEntries(appendPackageUserAgent(new Headers()));
  if (title) headers["x-title"] = title;
  if (referer) headers["http-referer"] = referer;
  return headers;
}

export function withGatewayTraceContext(
  model: LanguageModel,
  profile: ModelProfile,
  createTraceContextHeaders?: () => Record<string, string> | undefined,
): LanguageModel {
  if (!profile.gateway || createTraceContextHeaders === undefined) return model;
  const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;
  if (typeof model === "string" && typeof provider.languageModel !== "function") return model;
  const gatewayModel = typeof model === "string" ? provider.languageModel(model) : model;
  if (gatewayModel.provider.split(".")[0] !== "gateway") return model;
  const middleware: LanguageModelMiddleware = {
    async transformParams({ params }) {
      const traceHeaders = createTraceContextHeaders();
      return traceHeaders === undefined
        ? params
        : { ...params, headers: { ...params.headers, ...traceHeaders } };
    },
  };
  return wrapLanguageModel({ model: gatewayModel, middleware });
}

export async function resolveEffectiveRuntimeModel(
  step: Step,
  run?: ValueRun,
): Promise<{
  readonly choice: ModelChoice;
  readonly model: RuntimeModel;
}> {
  const choice = run === undefined ? await stepModel(step) : await evaluateStepModel(step, run);
  if (choice === undefined) {
    throw new Error(
      "The dynamic model returned no model, so there's none to call. Return a model from its render or record.",
    );
  }
  return {
    choice,
    model: choice.model ?? (await step.config.resolveModel(choice.reference)),
  };
}
