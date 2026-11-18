import {
  CompileAgentError,
  type CompileAgentResult,
  compileAgent,
} from "#compiler/compile-agent.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";
import { type ApplicationInfo, getApplicationInfo } from "#internal/application/paths.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";

export interface ApplicationInspectionMessaging {
  readonly createSessionRoutePath: string;
  readonly sessionMessagesRoutePattern: string;
  readonly streamRoutePattern: string;
}

export interface ApplicationInspection {
  readonly application: ApplicationInfo;
  readonly compileError?: string;
  readonly compiledState: CompileAgentResult | null;
  readonly messaging: ApplicationInspectionMessaging;
}

export async function inspectApplication(appRoot: string): Promise<ApplicationInspection> {
  const { compileError, compiledState } = await loadCompiledApplicationState(appRoot);
  const application = getApplicationInfo(compiledState?.project.appRoot ?? appRoot);

  return {
    application,
    ...(compileError !== undefined && { compileError }),
    compiledState,
    messaging: {
      createSessionRoutePath: EVE_SESSION_ROUTE_PATH,
      sessionMessagesRoutePattern: EVE_SESSION_ROUTE_PATTERN,
      streamRoutePattern: EVE_SESSION_STREAM_ROUTE_PATTERN,
    },
  };
}

async function loadCompiledApplicationState(appRoot: string): Promise<{
  readonly compileError?: string;
  readonly compiledState: CompileAgentResult | null;
}> {
  try {
    return { compiledState: await compileAgent({ reportWarnings: false, startPath: appRoot }) };
  } catch (error) {
    if (error instanceof CompileAgentError) {
      return { compiledState: error.result };
    }

    if (error instanceof DiscoveryProjectResolutionError) {
      return { compiledState: null };
    }

    return { compileError: toErrorMessage(error), compiledState: null };
  }
}
