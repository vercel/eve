import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV } from "#internal/application/build-output-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";

export { EVE_WORKFLOW_FLOW_ROUTE_PATH };

/** `vercel.json` `bunVersion` values Vercel accepts, e.g. `1.x` or `1.4.x`. */
const VERCEL_BUN_VERSION_PATTERN = /^\d+(?:\.\d+)?\.x$/;

/** The `bunVersion` an app's `vercel.json` selects, or undefined when absent or not a value Vercel accepts. */
export function parseVercelBunVersion(config: unknown): string | undefined {
  const bunVersion =
    typeof config === "object" && config !== null && "bunVersion" in config
      ? (config as { bunVersion?: unknown }).bunVersion
      : undefined;
  return typeof bunVersion === "string" && VERCEL_BUN_VERSION_PATTERN.test(bunVersion)
    ? bunVersion
    : undefined;
}

/**
 * Reads `bunVersion` from the app's `vercel.json`, the same file Nitro's Vercel
 * preset reads to decide the function runtime. A missing or unparsable file
 * selects nothing.
 */
export async function readVercelBunVersion(appRoot: string): Promise<string | undefined> {
  try {
    return parseVercelBunVersion(JSON.parse(await readFile(join(appRoot, "vercel.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Builds eve's Vercel preset options.
 *
 * The flow route's `functionRules` entry makes Nitro emit a dedicated
 * `flow.func` from the same build output, carrying the agent's queue trigger,
 * an extended execution window, and the environment the deployed workflow
 * runtime needs. Every other function setting (memory, streaming) is inherited
 * from the base server function config.
 *
 * When `vercel.json` selects a Bun version, the function runtime is derived from
 * it (`1.4.x` → `bun1.4.x`). Nitro's own detection maps every `bunVersion` to
 * `bun1.x`, which would silently pin the deployed function to an older Bun than
 * the one that installed and built it.
 */
export function createEveVercelOptions(input: {
  agentName: string;
  enabled: boolean;
  publicRoutePrefix?: string;
  workspaceMember?: boolean;
  bunVersion?: string;
}) {
  if (!input.enabled) {
    return undefined;
  }

  const environment: Record<string, string> = {
    // Reject replay decisions made from an event log that missed a
    // concurrent wake.
    WORKFLOW_PRECONDITION_GUARD: "1",
  };

  // Bake the agent's public mount into the flow function so callback-URL
  // minting inside the deployed workflow runtime resolves a routable path
  // when a multi-agent host proxies the agent behind a prefix.
  const publicRoutePrefix = normalizePublicRoutePrefix(input.publicRoutePrefix);
  if (publicRoutePrefix !== undefined) {
    environment[EVE_PUBLIC_ROUTE_PREFIX_ENV] = publicRoutePrefix;
  }
  if (input.workspaceMember === true) {
    environment[EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV] = "1";
  }

  const functions =
    input.bunVersion !== undefined && VERCEL_BUN_VERSION_PATTERN.test(input.bunVersion)
      ? { runtime: `bun${input.bunVersion}` }
      : undefined;

  return {
    config: {
      version: 3 as const,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    },
    ...(functions === undefined ? {} : { functions }),
    functionRules: {
      [EVE_WORKFLOW_FLOW_ROUTE_PATH]: {
        maxDuration: "max" as const,
        experimentalTriggers: [createEveWorkflowQueueTrigger(input.agentName)],
        environment,
      },
    },
  };
}
