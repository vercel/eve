import type { LanguageModel } from "ai";

import type { CompactionConfig, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { contextStorage } from "#context/container.js";
import { getEffectiveModelSelection } from "#reactions/kinds/model.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { appendPackageUserAgent } from "#internal/user-agent.js";

/**
 * Builds AI Gateway app attribution headers, including eve's User-Agent product token, for a
 * Gateway-routed model. Direct-provider models receive no Gateway-specific headers.
 */
export function buildGatewayAttributionHeaders(
  profile: ModelProfile,
  runtimeIdentity: ToolLoopHarnessConfig["runtimeIdentity"],
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

export async function resolveEffectiveRuntimeModel(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly ctx: ReturnType<typeof contextStorage.getStore>;
  readonly session: HarnessSession;
}): Promise<{
  readonly model: LanguageModel;
  readonly session: HarnessSession;
}> {
  if (input.ctx === undefined) {
    const reference = input.session.agent.modelReference;
    if (reference === undefined) {
      throw new Error("Dynamic model selection is unavailable outside an eve runtime context.");
    }
    return {
      model: await input.config.resolveModel(reference),
      session: input.session,
    };
  }

  const selected = getEffectiveModelSelection(input.ctx);

  if (selected === null) {
    throw new Error(
      "Dynamic model selection is required before model-dependent work begins. Add a matching resolver handler that returns a concrete model.",
    );
  }

  return {
    model:
      selected.model !== undefined
        ? selected.model
        : await input.config.resolveModel(selected.reference),
    session: updateSessionModelReference(input.session, selected.reference),
  };
}

function updateSessionModelReference(
  session: HarnessSession,
  modelReference: RuntimeModelReference,
): HarnessSession {
  if (session.agent.modelReference === modelReference) return session;
  return {
    ...session,
    agent: {
      ...session.agent,
      modelReference,
    },
    compaction: updateCompactionThresholdForModelReference({
      compaction: session.compaction,
      modelReference,
    }),
  };
}

function updateCompactionThresholdForModelReference(input: {
  readonly compaction: CompactionConfig;
  readonly modelReference: RuntimeModelReference;
}): CompactionConfig {
  if (input.modelReference.contextWindowTokens === undefined) {
    return input.compaction;
  }

  return {
    ...input.compaction,
    threshold: Math.max(
      1,
      Math.floor(
        input.modelReference.contextWindowTokens * (input.compaction.thresholdPercent ?? 0.9),
      ),
    ),
  };
}
