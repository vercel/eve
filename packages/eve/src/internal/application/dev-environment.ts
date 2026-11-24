import { readEnv } from "#runtime-env/env.js";
import { join, resolve } from "#runtime-env/host-path.js";
import { platformContext } from "#platform/context.js";

export const EVE_DEV_ENV_FLAG = "EVE_DEV";

export const EVE_DEV_STATE_DIR_ENV = "EVE_DEV_STATE_DIR";

export function resolveDevelopmentStateDirectory(appRoot: string): string {
  const override = readEnv(EVE_DEV_STATE_DIR_ENV);
  if (!isEveDevEnvironment() || override === undefined || override.length === 0) {
    return join(appRoot, ".eve");
  }
  return resolve(appRoot, override);
}

type ConversationEnvironment = "development" | "preview" | "production";

export function isEveDevEnvironment(): boolean {
  return readEnv(EVE_DEV_ENV_FLAG) === "1";
}

export function isLocalDevelopmentServer(): boolean {
  return platformContext().deployment.isPlatformDevelopmentServer() || isEveDevEnvironment();
}

export function resolveInstrumentationEnvironment(): ConversationEnvironment {
  const environmentKind = platformContext().deployment.environmentKind();
  if (isEveDevEnvironment() || environmentKind === "development") return "development";
  return environmentKind === "preview" ? "preview" : "production";
}

export const EVE_EVALUATION_ENV_FLAG = "EVE_EVALUATION";

export const EVE_EVALUATION_RUN_ID_ENV = "EVE_EVALUATION_RUN_ID";

function isEveEvaluationEnvironment(): boolean {
  return readEnv(EVE_EVALUATION_ENV_FLAG) === "1";
}

export function resolveEveEvaluationRunId(): string | undefined {
  if (!isEveEvaluationEnvironment()) return undefined;
  const runId = readEnv(EVE_EVALUATION_RUN_ID_ENV);
  return runId === undefined || runId.length === 0 ? undefined : runId;
}
