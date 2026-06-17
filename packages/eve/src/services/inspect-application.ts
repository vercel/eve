import {
  CompileAgentError,
  type CompileAgentResult,
  compileAgent,
} from "#compiler/compile-agent.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";
import { type ApplicationInfo, getApplicationInfo } from "#internal/application/paths.js";
import {
  EVE_CREATE_SESSION_ROUTE_PATH,
  EVE_CONTINUE_SESSION_ROUTE_PATTERN,
  EVE_MESSAGE_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";

/**
 * Stable message-contract details surfaced to CLI consumers.
 */
export interface ApplicationInspectionMessaging {
  readonly createSessionRoutePath: string;
  readonly continueSessionRoutePattern: string;
  readonly streamRoutePattern: string;
}

/**
 * Structured application inspection data for CLI surfaces.
 */
export interface ApplicationInspection {
  readonly application: ApplicationInfo;
  readonly compiledState: CompileAgentResult | null;
  readonly messaging: ApplicationInspectionMessaging;
}

/**
 * Resolves application details, compile artifacts, and the active message
 * contract for one eve application root.
 */
export async function inspectApplication(appRoot: string): Promise<ApplicationInspection> {
  const compiledState = await loadCompiledApplicationState(appRoot);
  const application = getApplicationInfo(compiledState?.project.appRoot ?? appRoot);

  return {
    application,
    compiledState,
    messaging: {
      createSessionRoutePath: EVE_CREATE_SESSION_ROUTE_PATH,
      continueSessionRoutePattern: EVE_CONTINUE_SESSION_ROUTE_PATTERN,
      streamRoutePattern: EVE_MESSAGE_STREAM_ROUTE_PATTERN,
    },
  };
}

async function loadCompiledApplicationState(appRoot: string): Promise<CompileAgentResult | null> {
  try {
    return await compileAgent({
      startPath: appRoot,
    });
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
