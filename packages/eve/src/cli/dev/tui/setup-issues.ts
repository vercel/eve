import { join } from "node:path";

import type { AgentInfoResult } from "#client/index.js";
import { pathExists } from "#setup/path-exists.js";

/** One boot-time setup problem the TUI can point at a fixing command. */
export type SetupIssue =
  | {
      /** Diagnostics never authorize a command by themselves. */
      kind: "attention";
      /** Short category label, e.g. "AI Gateway credentials". */
      label: string;
      /** The slash command that fixes it, e.g. "/model". */
      command: string;
    }
  | {
      /** Positive runtime evidence that no model provider is configured. */
      kind: "model-provider-unconfigured";
      label: string;
      command: "/model";
    };

/** What a boot detection may inspect. */
export interface BootDetectionContext {
  /** The local project the in-process dev server is running. */
  appRoot: string;
  /** `eve dev` loads the project env files before the TUI boots. */
  env: Record<string, string | undefined>;
  /** Best-effort agent truth from the header fetch; undefined when unavailable. */
  info?: AgentInfoResult;
}

/**
 * One installation-state check run at TUI boot, before the user hits the
 * failure mid-conversation. Detections must stay cheap and local (env reads,
 * a single fs stat) — they run between the header and the first prompt.
 */
export interface BootDetection {
  id: string;
  detect(context: BootDetectionContext): SetupIssue[] | Promise<SetupIssue[]>;
}

type ModelProviderAccess = "configured" | "unconfigured" | "unknown";
type LocalGatewayCredential = "api-key" | "oidc";

function hasEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return value !== undefined && value.trim().length > 0;
}

function localGatewayCredential(
  env: Record<string, string | undefined>,
): LocalGatewayCredential | undefined {
  if (hasEnvValue(env, "AI_GATEWAY_API_KEY")) return "api-key";
  if (hasEnvValue(env, "VERCEL_OIDC_TOKEN")) return "oidc";
  return undefined;
}

/**
 * Carries positive local credential evidence into the agent-info snapshot the
 * TUI caches. The local TUI and dev server share `process.env`, so a loaded
 * credential is usable even when an earlier `/info` response says disconnected.
 */
export function withLocalGatewayCredentialEvidence(
  info: AgentInfoResult | undefined,
  env: Record<string, string | undefined>,
): AgentInfoResult | undefined {
  const credential = localGatewayCredential(env);
  if (info === undefined || credential === undefined) return info;

  const model = info.agent.model;
  const endpoint = model.endpoint;
  if (endpoint?.kind === "external" || (endpoint?.kind === "gateway" && endpoint.connected)) {
    return info;
  }
  if (endpoint?.kind !== "gateway" && model.routing?.kind !== "gateway") return info;

  return {
    ...info,
    agent: {
      ...info.agent,
      model: {
        ...model,
        endpoint: { kind: "gateway", connected: true, credential },
      },
    },
  };
}

/** Classifies only evidence the boot path can actually observe. */
function modelProviderAccess(
  context: Pick<BootDetectionContext, "env" | "info">,
): ModelProviderAccess {
  const info = withLocalGatewayCredentialEvidence(context.info, context.env);
  const endpoint = info?.agent.model.endpoint;
  if (endpoint?.kind === "external") return "configured";
  if (endpoint?.kind === "gateway" && endpoint.connected) return "configured";

  // Older servers omit the composed endpoint status. Their routing and the
  // dev process's loaded env can prove configuration, but absence proves
  // nothing about credentials available only inside the running server.
  if (info?.agent.model.routing?.kind === "external") return "configured";
  if (localGatewayCredential(context.env) !== undefined) return "configured";
  if (endpoint?.kind === "gateway") return "unconfigured";
  return "unknown";
}

/**
 * One diagnosis for the model-provider path. An external-provider model is
 * skipped entirely: it reaches the model with its own provider key, so gateway
 * linking and credentials don't apply (and /model can't reconfigure it). For a
 * gateway model it reports only the most-root cause; an unlinked directory
 * implies missing OIDC, so listing both would double-count what /model's
 * provider step fixes in one pass. The header and detection receive the same
 * local-credential-normalized endpoint snapshot. Their absence remains
 * unknown and cannot launch setup. A hint, not an error: the model call stays
 * the source of truth.
 */
const modelProvider: BootDetection = {
  id: "model-provider",
  async detect({ appRoot, env, info }) {
    const access = modelProviderAccess({ env, info });

    if (access === "configured") {
      return [];
    }
    const linked = await pathExists(join(appRoot, ".vercel", "project.json"));
    if (access === "unconfigured") {
      return [
        {
          kind: "model-provider-unconfigured",
          label: linked ? "AI Gateway credentials missing" : "model provider not linked",
          command: "/model",
        },
      ];
    }
    if (linked) {
      return [{ kind: "attention", label: "AI Gateway credentials missing", command: "/model" }];
    }
    return [{ kind: "attention", label: "model provider not linked", command: "/model" }];
  },
};

/** The built-in boot detections, run in order. */
export const BOOT_DETECTIONS: readonly BootDetection[] = [modelProvider];

/**
 * The logged-out hint. Deliberately not a {@link BootDetection}: confirming
 * Vercel login is a `vercel whoami` subprocess, too costly for the cheap,
 * local detections that run between the header and the first prompt. The
 * runner probes it off the critical path and renders this issue only when the
 * probe resolves logged-out.
 */
export const LOGIN_SETUP_ISSUE: SetupIssue = {
  kind: "attention",
  label: "not logged in",
  command: "/login",
};

/**
 * The CLI-missing hint, surfaced by the same off-critical-path probe as
 * {@link LOGIN_SETUP_ISSUE}. When the `vercel` binary is absent the probe
 * reports this instead of the login hint, so the diagnostic points at its fix
 * command (`/vc`) rather than a logged-out state the probe can't determine.
 */
export const CLI_MISSING_SETUP_ISSUE: SetupIssue = {
  kind: "attention",
  label: "Vercel CLI not found",
  command: "/vc",
};

/**
 * Runs the boot detections and aggregates their issues. Each detection is
 * individually guarded: one that throws contributes nothing and never blocks
 * the prompt.
 */
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

/** Places the auth issue before boot-time setup issues. */
export function orderedSetupIssues(
  bootIssues: readonly SetupIssue[],
  authIssue: SetupIssue | undefined,
): SetupIssue[] {
  return authIssue === undefined ? [...bootIssues] : [authIssue, ...bootIssues];
}

/** The command and entry step authorized by positive setup evidence. */
export interface AutomaticSetupCommand {
  prompt: "/model";
  initialModelStep: "provider";
}

/** Returns the only command authorized to run from positive setup evidence. */
export function automaticSetupCommand(
  issues: readonly SetupIssue[],
): AutomaticSetupCommand | undefined {
  return issues.some((issue) => issue.kind === "model-provider-unconfigured")
    ? { prompt: "/model", initialModelStep: "provider" }
    : undefined;
}

/**
 * The attention line's body, mirroring Claude Code's
 * `1 setup issue: MCP · /doctor` shape; the renderer prefixes the warning
 * glyph and paints the command blue.
 */
export function formatSetupIssuesLine(issues: readonly SetupIssue[]): string {
  const noun = issues.length === 1 ? "setup issue" : "setup issues";
  const entries = issues.map((issue) => `${issue.label} · ${issue.command}`).join(", ");
  return `${issues.length} ${noun}: ${entries}`;
}
