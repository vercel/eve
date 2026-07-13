import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { toErrorMessage } from "#shared/errors.js";

const WORKFLOW_LOCAL_DATA_DIR_ENV = "WORKFLOW_LOCAL_DATA_DIR";
const DEFAULT_WORKFLOW_LOCAL_DATA_DIRECTORY = ".workflow-data";
const DEV_WORKFLOW_DATA_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const WORKFLOW_RUN_FILE_PREFIX = "wrun_";
const WORKFLOW_STREAM_CHUNK_PREFIX = "strm_";

/**
 * Workflow run statuses that can never resume. Non-terminal runs (including
 * parked HITL turns) must survive dev-store cleanup.
 */
export const TERMINAL_WORKFLOW_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

/**
 * Resolves the local workflow world's data directory the same way the
 * Workflow SDK does, honoring `WORKFLOW_LOCAL_DATA_DIR` and defaulting to
 * `.workflow-data` under the app root.
 */
export function resolveWorkflowLocalDataDirectory(appRoot: string): string {
  const override = process.env[WORKFLOW_LOCAL_DATA_DIR_ENV];

  if (override === undefined || override.trim() === "") {
    return join(appRoot, DEFAULT_WORKFLOW_LOCAL_DATA_DIRECTORY);
  }

  return isAbsolute(override) ? override : resolve(appRoot, override);
}

/**
 * Starts best-effort retention cleanup for the local workflow store without
 * delaying `eve dev` startup.
 *
 * The local workflow world persists every run, event, step, and hook as an
 * individual file and never deletes them, while its queue lists whole
 * directories per operation — so an always-on dev server's queue cost grows
 * with lifetime traffic instead of live work. Removing terminal runs after a
 * retention window keeps those scans bounded.
 */
export function pruneWorkflowLocalDataInBackground(appRoot: string): void {
  void pruneWorkflowLocalData({ appRoot }).catch((error) => {
    console.warn(`[eve:dev] failed to prune stale local workflow runs: ${toErrorMessage(error)}`);
  });
}

/**
 * Deletes terminal-status workflow runs older than the retention window from
 * the local workflow store, together with their events, steps, hooks (and
 * the hooks' token sidecars), and stream files. Runs in any non-terminal
 * status are never touched, whatever their age, so parked HITL runs stay
 * resumable.
 */
export async function pruneWorkflowLocalData(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly retentionWindowMs?: number;
}): Promise<void> {
  const dataDirectory = resolveWorkflowLocalDataDirectory(input.appRoot);
  const now = input.now ?? Date.now();
  const retentionWindowMs = input.retentionWindowMs ?? DEV_WORKFLOW_DATA_RETENTION_WINDOW_MS;
  const cutoffMs = now - retentionWindowMs;

  const runsDirectory = join(dataDirectory, "runs");
  const runFileNames = await readDirectoryNames(runsDirectory);
  if (runFileNames === undefined) {
    return;
  }

  const staleRunIds = new Set<string>();

  for (const fileName of runFileNames) {
    if (!fileName.startsWith(WORKFLOW_RUN_FILE_PREFIX) || !fileName.endsWith(".json")) {
      continue;
    }

    const runPath = join(runsDirectory, fileName);
    const run = await readWorkflowRunRecord(runPath);
    if (run === undefined || !TERMINAL_WORKFLOW_RUN_STATUSES.has(run.status)) {
      continue;
    }

    const lastTouchedMs = run.lastTouchedMs ?? (await fileMtimeMs(runPath));
    if (lastTouchedMs !== undefined && lastTouchedMs < cutoffMs) {
      staleRunIds.add(fileName.slice(0, -".json".length));
    }
  }

  if (staleRunIds.size === 0) {
    return;
  }

  await Promise.all(
    [...staleRunIds].map((runId) => rm(join(runsDirectory, `${runId}.json`), { force: true })),
  );
  await removeRunLinkedFiles(join(dataDirectory, "events"), staleRunIds, runIdFromRunPrefixedName);
  await removeRunLinkedFiles(join(dataDirectory, "steps"), staleRunIds, runIdFromRunPrefixedName);
  await removeRunLinkedFiles(
    join(dataDirectory, "streams", "runs"),
    staleRunIds,
    runIdFromStreamRunName,
  );
  await removeRunLinkedFiles(
    join(dataDirectory, "streams", "chunks"),
    staleRunIds,
    runIdFromStreamChunkName,
  );
  await removeRunLinkedHooks(join(dataDirectory, "hooks"), staleRunIds);
}

interface WorkflowRunRecord {
  readonly lastTouchedMs: number | undefined;
  readonly status: string;
}

async function readWorkflowRunRecord(runPath: string): Promise<WorkflowRunRecord | undefined> {
  let value: unknown;

  try {
    value = JSON.parse(await readFile(runPath, "utf8"));
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string") {
    return undefined;
  }

  let lastTouchedMs: number | undefined;
  for (const key of ["updatedAt", "createdAt"]) {
    const raw = record[key];
    if (typeof raw !== "string") {
      continue;
    }

    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      lastTouchedMs = parsed;
      break;
    }
  }

  return { lastTouchedMs, status: record.status };
}

async function readDirectoryNames(directory: string): Promise<readonly string[] | undefined> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function fileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** `wrun_<id>-evnt_<id>.json` / `wrun_<id>-step_<id>.json` → `wrun_<id>` */
function runIdFromRunPrefixedName(fileName: string): string | undefined {
  if (!fileName.startsWith(WORKFLOW_RUN_FILE_PREFIX)) {
    return undefined;
  }

  const separator = fileName.indexOf("-");
  return separator > WORKFLOW_RUN_FILE_PREFIX.length ? fileName.slice(0, separator) : undefined;
}

/** `wrun_<id>.json` → `wrun_<id>` */
function runIdFromStreamRunName(fileName: string): string | undefined {
  if (!fileName.startsWith(WORKFLOW_RUN_FILE_PREFIX) || !fileName.endsWith(".json")) {
    return undefined;
  }

  return fileName.slice(0, -".json".length);
}

/** `strm_<id>_<stream>-chnk_<id>.bin` → `wrun_<id>` (the ULID matches the run's) */
function runIdFromStreamChunkName(fileName: string): string | undefined {
  if (!fileName.startsWith(WORKFLOW_STREAM_CHUNK_PREFIX)) {
    return undefined;
  }

  const separator = fileName.indexOf("_", WORKFLOW_STREAM_CHUNK_PREFIX.length);
  if (separator === -1) {
    return undefined;
  }

  return `${WORKFLOW_RUN_FILE_PREFIX}${fileName.slice(WORKFLOW_STREAM_CHUNK_PREFIX.length, separator)}`;
}

async function removeRunLinkedFiles(
  directory: string,
  staleRunIds: ReadonlySet<string>,
  runIdFromFileName: (fileName: string) => string | undefined,
): Promise<void> {
  const fileNames = await readDirectoryNames(directory);
  if (fileNames === undefined) {
    return;
  }

  await Promise.all(
    fileNames.map(async (fileName) => {
      const runId = runIdFromFileName(fileName);
      if (runId === undefined || !staleRunIds.has(runId)) {
        return;
      }

      await rm(join(directory, fileName), { force: true, recursive: true });
    }),
  );
}

/**
 * Hooks carry their run linkage inside the JSON body rather than the filename.
 * Each hook also owns up to two sidecars under `hooks/tokens/` — the token
 * claim file and the recovery marker — that are only reachable through the
 * hook body, so they are removed here alongside the hook file (sidecars
 * first, so an interrupted prune leaves the hook file to retry from rather
 * than unreachable sidecars).
 */
async function removeRunLinkedHooks(
  directory: string,
  staleRunIds: ReadonlySet<string>,
): Promise<void> {
  const fileNames = await readDirectoryNames(directory);
  if (fileNames === undefined) {
    return;
  }

  await Promise.all(
    fileNames.map(async (fileName) => {
      if (!fileName.endsWith(".json")) {
        return;
      }

      const path = join(directory, fileName);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        return;
      }

      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return;
      }

      const hook = value as Record<string, unknown>;
      const runId = hook.runId;
      if (typeof runId !== "string" || !staleRunIds.has(runId)) {
        return;
      }

      await removeHookTokenSidecars(directory, runId, hook);
      await rm(path, { force: true });
    }),
  );
}

/**
 * Deletes a hook's `hooks/tokens/` sidecars: the token claim file
 * (`<sha256(token)>.json`, which enforces token uniqueness and would
 * otherwise keep the token claimed forever) and the recovery marker
 * (`<sha256(token \0 runId \0 hookId)>.recovery.json`). The paths mirror
 * `hashToken` / `hookRecoveryMarkerPath` in `@workflow/world-local`'s
 * storage helpers, which the package does not export.
 */
async function removeHookTokenSidecars(
  hooksDirectory: string,
  runId: string,
  hook: Record<string, unknown>,
): Promise<void> {
  const { hookId, token } = hook;
  if (typeof token !== "string") {
    return;
  }

  const tokensDirectory = join(hooksDirectory, "tokens");
  const removals = [rm(join(tokensDirectory, `${sha256Hex(token)}.json`), { force: true })];
  if (typeof hookId === "string") {
    const markerKey = sha256Hex(`${token}\x00${runId}\x00${hookId}`);
    removals.push(rm(join(tokensDirectory, `${markerKey}.recovery.json`), { force: true }));
  }

  await Promise.all(removals);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
