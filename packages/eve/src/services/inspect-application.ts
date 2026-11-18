import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { reportDiscoverWarnings } from "#compiler/report-warnings.js";
import { type ApplicationInfo, getApplicationInfo } from "#internal/application/paths.js";
import { recordBundledModules } from "#internal/bundler/bundled-module-recorder.js";
import {
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
import { readCachedCompile, writeCachedCompile } from "#services/inspect-cache.js";

export interface ApplicationInspectionMessaging {
  readonly createSessionRoutePath: string;
  readonly sessionMessagesRoutePattern: string;
  readonly streamRoutePattern: string;
}

export interface ApplicationInspection {
  readonly application: ApplicationInfo;
  readonly compiledState: CompileAgentResult | null;
  readonly messaging: ApplicationInspectionMessaging;
}

export type ApplicationInspectionCache = "off" | "read" | "refresh";

export async function inspectApplication(
  appRoot: string,
  options: { readonly cache?: ApplicationInspectionCache } = {},
): Promise<ApplicationInspection> {
  const compiledState = await loadCompiledApplicationState(appRoot, options.cache ?? "off");
  const application = getApplicationInfo(compiledState?.project.appRoot ?? appRoot);

  return {
    application,
    compiledState,
    messaging: {
      createSessionRoutePath: EVE_SESSION_ROUTE_PATH,
      sessionMessagesRoutePattern: EVE_SESSION_ROUTE_PATTERN,
      streamRoutePattern: EVE_SESSION_STREAM_ROUTE_PATTERN,
    },
  };
}

async function loadCompiledApplicationState(
  appRoot: string,
  cache: ApplicationInspectionCache,
): Promise<CompileAgentResult | null> {
  if (cache === "read") {
    const cached = await readCachedCompile(appRoot);
    if (cached !== null) {
      reportDiscoverWarnings(cached.diagnostics);
      return cached;
    }
  }

  const [{ CompileAgentError, compileAgent }, { DiscoveryProjectResolutionError }] =
    await Promise.all([import("#compiler/compile-agent.js"), import("#discover/project.js")]);
  const moduleIds = new Set<string>();
  const startedAtMs = performance.timeOrigin + performance.now();
  try {
    const result = await recordBundledModules(moduleIds, () =>
      compileAgent({ startPath: appRoot }),
    );
    if (cache !== "off") {
      await writeCachedCompile({ appRoot, moduleIds, result, startedAtMs });
    }
    return result;
  } catch (error) {
    if (error instanceof CompileAgentError) {
      return error.result;
    }

    if (error instanceof DiscoveryProjectResolutionError) {
      return null;
    }

    throw error;
  }
}
