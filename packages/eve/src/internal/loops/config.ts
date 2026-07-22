import type { LoopKind } from "#internal/loops/contract.js";

export const LOOP_KIND_ENV = "EVE_LOOP";
export const LOOP_TEMPORAL_DB_ENV = "EVE_LOOP_TEMPORAL_DB";
export const LOOP_TEMPORAL_UI_PORT_ENV = "EVE_LOOP_TEMPORAL_UI_PORT";

export interface LoopTemporalDevServerOptions {
  readonly dbFilename?: string;
  readonly uiPort?: number;
}

/**
 * Reads optional observability settings for the local Temporal dev server:
 * a SQLite persistence file and a Web UI port. Both default to off, which
 * keeps the server in-memory and headless.
 */
export function readLoopTemporalDevServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LoopTemporalDevServerOptions {
  const dbFilename = environment[LOOP_TEMPORAL_DB_ENV]?.trim();
  const rawUiPort = environment[LOOP_TEMPORAL_UI_PORT_ENV]?.trim();

  let uiPort: number | undefined;
  if (rawUiPort !== undefined && rawUiPort !== "") {
    uiPort = Number(rawUiPort);
    if (!Number.isInteger(uiPort) || uiPort <= 0 || uiPort > 65_535) {
      throw new TypeError(
        `${LOOP_TEMPORAL_UI_PORT_ENV} must be a port number; received "${rawUiPort}".`,
      );
    }
  }

  const options: { dbFilename?: string; uiPort?: number } = {};
  if (dbFilename !== undefined && dbFilename !== "") options.dbFilename = dbFilename;
  if (uiPort !== undefined) options.uiPort = uiPort;
  return options;
}

/** Reads the selected loop implementation. The existing Workflow driver is the default. */
export function readLoopKind(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LoopKind {
  const raw = environment[LOOP_KIND_ENV]?.trim();
  if (raw === undefined || raw === "") return "workflow";

  if (raw === "inline" || raw === "workflow" || raw === "temporal") {
    return raw;
  }

  throw new TypeError(
    `${LOOP_KIND_ENV} must be "inline", "workflow", or "temporal"; received "${raw}".`,
  );
}
