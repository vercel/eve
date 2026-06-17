import { join } from "node:path";

import type { AgentInfoResult } from "#client/index.js";
import { pathExists } from "#setup/path-exists.js";

/** One boot-time setup problem the TUI can point at a fixing command. */
export interface SetupIssue {
  /** Short category label, e.g. "AI Gateway credentials". */
  label: string;
  /** The slash command that fixes it, e.g. "/model". */
  command: string;
}

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

/**
 * One diagnosis for the model-provider path. An external-provider model is
 * skipped entirely: it reaches the model with its own provider key, so gateway
 * linking and credentials don't apply (and /model can't reconfigure it). For a
 * gateway model it reports only the most-root cause; an unlinked directory
 * implies missing OIDC, so listing both would double-count what /model's
 * provider step fixes in one pass. With either gateway credential present the
 * provider is satisfied and an unlinked directory is not flagged (linking only
 * matters for deploy). A hint, not an error: the model call stays the source of
 * truth.
 */
const modelProvider: BootDetection = {
  id: "model-provider",
  async detect({ appRoot, env, info }) {
    const endpoint = info?.agent.model.endpoint;
    const isEndpointExternal =
      endpoint?.kind === "external" ||
      (endpoint === undefined && info?.agent.model.routing?.kind === "external");
    const isAIGatewayConnected = endpoint?.kind === "gateway" && endpoint.connected;

    // The running server owns endpoint readiness. Fall back to routing and
    // local credential checks only when talking to a legacy server that did
    // not return the composed endpoint state.
    if (isEndpointExternal || isAIGatewayConnected) {
      return [];
    }
    if (env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN) {
      return [];
    }
    if (!(await pathExists(join(appRoot, ".vercel", "project.json")))) {
      return [{ label: "model provider not linked", command: "/model" }];
    }
    return [{ label: "AI Gateway credentials missing", command: "/model" }];
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
export const LOGIN_SETUP_ISSUE: SetupIssue = { label: "not logged in", command: "/login" };

/**
 * The CLI-missing hint, surfaced by the same off-critical-path probe as
 * {@link LOGIN_SETUP_ISSUE}. When the `vercel` binary is absent the probe
 * reports this instead of the login hint, so the diagnostic points at its fix
 * command (`/vc`) rather than a logged-out state the probe can't determine.
 */
export const CLI_MISSING_SETUP_ISSUE: SetupIssue = {
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
