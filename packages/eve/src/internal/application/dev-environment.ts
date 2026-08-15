/** Environment flag set for processes that belong to an `eve dev` session. */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/** Reports whether this process belongs to an `eve dev` session. */
export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

/** Environment flag set for a server `eve eval` started to run against. */
export const EVE_EVALUATION_ENV_FLAG = "EVE_EVALUATION";

/** Stable identifier for the local eval run this server was started to serve. */
export const EVE_EVALUATION_RUN_ID_ENV = "EVE_EVALUATION_RUN_ID";

/**
 * Reports whether this process exists to serve an eval run.
 *
 * False for a server that `eve eval --url` merely points at: that process was
 * started to serve ordinary traffic and cannot know an eval is among it.
 */
export function isEveEvaluationEnvironment(): boolean {
  return process.env[EVE_EVALUATION_ENV_FLAG] === "1";
}

export function resolveEveEvaluationRunId(): string | undefined {
  if (!isEveEvaluationEnvironment()) return undefined;
  const runId = process.env[EVE_EVALUATION_RUN_ID_ENV];
  return runId === undefined || runId.length === 0 ? undefined : runId;
}
