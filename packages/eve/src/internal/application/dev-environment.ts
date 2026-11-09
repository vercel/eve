import { join, resolve } from "node:path";

/** Environment flag set for processes that belong to an `eve dev` session. */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/**
 * Internal handoff from `eve eval` to the development server it starts; not a
 * user-facing setting.
 */
export const EVE_DEV_STATE_DIR_ENV = "EVE_DEV_STATE_DIR";

/**
 * Resolves where a development server keeps the state only one server per app
 * root may own: the active runtime generation and its snapshots, the local
 * Workflow World data, and the record a second `eve dev` attaches through.
 * Defaults to `<appRoot>/.eve`. `eve eval` points it at a per-run directory so
 * its server can run beside an `eve dev` session without touching it.
 */
export function resolveDevelopmentStateDirectory(appRoot: string): string {
  const override = process.env[EVE_DEV_STATE_DIR_ENV];
  // Production servers (`eve start`) also read the local Workflow store
  // through here; a stray override must never move their durable runs away
  // from the mounted `.eve/.workflow-data`.
  if (!isEveDevEnvironment() || override === undefined || override.length === 0) {
    return join(appRoot, ".eve");
  }
  return resolve(appRoot, override);
}

type ConversationEnvironment = "development" | "preview" | "production";

/** Reports whether this process belongs to an `eve dev` session. */
export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

/**
 * Reports whether this process is a local development server: `eve dev`
 * (`EVE_DEV=1`) or `vercel dev` (`VERCEL=1` with `VERCEL_ENV=development`).
 * This is a property of the deployment, never of an inbound request.
 */
export function isLocalDevelopmentServer(): boolean {
  if (process.env.VERCEL && process.env.VERCEL_ENV === "development") {
    return true;
  }
  return isEveDevEnvironment();
}

/** Resolves the deployment environment used by setup hooks and trace policies. */
export function resolveInstrumentationEnvironment(): ConversationEnvironment {
  if (isEveDevEnvironment() || process.env.VERCEL_ENV === "development") return "development";
  return process.env.VERCEL_ENV === "preview" ? "preview" : "production";
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
function isEveEvaluationEnvironment(): boolean {
  return process.env[EVE_EVALUATION_ENV_FLAG] === "1";
}

export function resolveEveEvaluationRunId(): string | undefined {
  if (!isEveEvaluationEnvironment()) return undefined;
  const runId = process.env[EVE_EVALUATION_RUN_ID_ENV];
  return runId === undefined || runId.length === 0 ? undefined : runId;
}
