import { join, resolve } from "node:path";

export const EVE_DEV_ENV_FLAG = "EVE_DEV";

export const EVE_DEV_STATE_DIR_ENV = "EVE_DEV_STATE_DIR";

export function resolveDevelopmentStateDirectory(appRoot: string): string {
  const override = process.env[EVE_DEV_STATE_DIR_ENV];
  if (!isEveDevEnvironment() || override === undefined || override.length === 0) {
    return join(appRoot, ".eve");
  }
  return resolve(appRoot, override);
}

type ConversationEnvironment = "development" | "preview" | "production";

export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

export function isLocalDevelopmentServer(): boolean {
  if (process.env.VERCEL && process.env.VERCEL_ENV === "development") {
    return true;
  }
  return isEveDevEnvironment();
}

export function resolveInstrumentationEnvironment(): ConversationEnvironment {
  if (isEveDevEnvironment() || process.env.VERCEL_ENV === "development") return "development";
  return process.env.VERCEL_ENV === "preview" ? "preview" : "production";
}

export const EVE_EVALUATION_ENV_FLAG = "EVE_EVALUATION";

export const EVE_EVALUATION_RUN_ID_ENV = "EVE_EVALUATION_RUN_ID";

function isEveEvaluationEnvironment(): boolean {
  return process.env[EVE_EVALUATION_ENV_FLAG] === "1";
}

export function resolveEveEvaluationRunId(): string | undefined {
  if (!isEveEvaluationEnvironment()) return undefined;
  const runId = process.env[EVE_EVALUATION_RUN_ID_ENV];
  return runId === undefined || runId.length === 0 ? undefined : runId;
}
