import { join } from "node:path";

import type { AgentInfoResult } from "#client/index.js";
import { hasEnvValue, resolveGatewayCredential } from "#internal/resolve-model-endpoint-status.js";
import { pathExists } from "#setup/path-exists.js";

export interface SetupIssue {
  kind: "attention";
  label: string;
  command: string;
}

export interface BootDetectionContext {
  appRoot: string;
  env: Record<string, string | undefined>;
  info?: AgentInfoResult;
}

export interface BootDetection {
  id: string;
  detect(context: BootDetectionContext): SetupIssue[] | Promise<SetupIssue[]>;
}

type ModelProviderAccess =
  | { kind: "unknown" }
  | { kind: "dynamic" }
  | { kind: "external" }
  | {
      kind: "gateway";
      runtime:
        | { status: "connected"; credential: "api-key" | "oidc" | "oauth" | "unrecognized" }
        | { status: "disconnected" }
        | { status: "unknown" };
    };

export function normalizeLocalModelEndpoint(
  info: AgentInfoResult | undefined,
  env: Record<string, string | undefined>,
): AgentInfoResult | undefined {
  const access = modelProviderAccess({ env, info });
  if (info === undefined || access.kind !== "gateway" || access.runtime.status !== "connected") {
    return info;
  }
  const { credential } = access.runtime;

  const model = info.agent.model;
  if (model.id === undefined || model.routing.kind !== "gateway") return info;
  const endpoint = model.endpoint;
  if (endpoint?.kind === "gateway" && endpoint.connected && endpoint.credential === credential) {
    return info;
  }
  const connectedEndpoint = {
    connected: true as const,
    credential,
    kind: "gateway" as const,
  };

  return {
    ...info,
    agent: {
      ...info.agent,
      model: {
        contextWindowTokens: model.contextWindowTokens,
        endpoint: connectedEndpoint,
        id: model.id,
        providerOptions: model.providerOptions,
        reasoning: model.reasoning,
        routing: model.routing,
        source: model.source,
      },
    },
  };
}

function modelProviderAccess(
  context: Pick<BootDetectionContext, "env" | "info">,
): ModelProviderAccess {
  const model = context.info?.agent.model;
  if (model?.routing?.kind === "dynamic") return { kind: "dynamic" };
  if (model?.routing?.kind === "external") return { kind: "external" };
  if (model?.routing?.kind !== "gateway") return { kind: "unknown" };

  const selected = context.env.EVE_MODEL_CONNECTION;
  const local = resolveGatewayCredential({
    apiKeyInEnv:
      (selected === undefined ||
        (selected === "ai-gateway-key" && context.env.EVE_MODEL_KEY_SOURCE !== "secret")) &&
      hasEnvValue(context.env.AI_GATEWAY_API_KEY),
    oidcAvailable:
      (selected === undefined || selected === "ai-gateway-project") &&
      hasEnvValue(context.env.VERCEL_OIDC_TOKEN),
  });
  if (local?.credential === "api-key") {
    return { kind: "gateway", runtime: { status: "connected", credential: "api-key" } };
  }
  const endpoint = model.endpoint;
  if (endpoint?.kind === "gateway" && endpoint.connected) {
    return {
      kind: "gateway",
      runtime: { status: "connected", credential: endpoint.credential },
    };
  }
  if (local !== undefined) {
    return { kind: "gateway", runtime: { status: "connected", credential: local.credential } };
  }
  if (endpoint?.kind === "gateway") return { kind: "gateway", runtime: { status: "disconnected" } };
  return { kind: "gateway", runtime: { status: "unknown" } };
}

const modelProvider: BootDetection = {
  id: "model-provider",
  async detect({ appRoot, env, info }) {
    const access = modelProviderAccess({ env, info });

    if (access.kind === "external" || access.kind === "dynamic") return [];
    if (access.kind !== "gateway" || access.runtime.status === "unknown") return [];
    if (access.runtime.status === "connected") return [];

    const linked = await pathExists(join(appRoot, ".vercel", "project.json"));
    return [
      {
        kind: "attention",
        label: linked ? "AI Gateway credentials missing" : "connect a model",
        command: "/login",
      },
    ];
  },
};

export const BOOT_DETECTIONS: readonly BootDetection[] = [modelProvider];

export const LOGIN_SETUP_ISSUE: SetupIssue = {
  kind: "attention",
  label: "not logged in",
  command: "/deploy",
};

export const CLI_MISSING_SETUP_ISSUE: SetupIssue = {
  kind: "attention",
  label: "Vercel CLI not found",
  command: "/deploy",
};

export async function detectSetupIssues(
  context: BootDetectionContext,
  detections: readonly BootDetection[] = BOOT_DETECTIONS,
): Promise<SetupIssue[]> {
  const results = await Promise.all(
    detections.map(async (detection) => {
      try {
        return await detection.detect(context);
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export function orderedSetupIssues(
  bootIssues: readonly SetupIssue[],
  authIssue: SetupIssue | undefined,
): SetupIssue[] {
  return authIssue === undefined ? [...bootIssues] : [authIssue, ...bootIssues];
}

export function formatSetupIssuesLine(issues: readonly SetupIssue[]): string {
  const noun = issues.length === 1 ? "setup issue" : "setup issues";
  const entries = issues.map((issue) => `${issue.label} · ${issue.command}`).join(", ");
  return `${issues.length} ${noun}: ${entries}`;
}
