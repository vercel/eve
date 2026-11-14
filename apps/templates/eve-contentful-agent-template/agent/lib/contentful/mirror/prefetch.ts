/**
 * Warms a new session sandbox for SQL over the mirror without delaying the session.
 *
 * @packageDocumentation
 */

import type { Experimental_SandboxSession } from "ai";

/* Runs the search_content script's warm mode; its output is discarded so nothing buffers. */
export const MIRROR_PREFETCH_COMMAND =
  "sh -c 'sh \"$HOME/.agents/skills/search_content/scripts/sql\" --warm >/dev/null 2>&1'";

/** The sandbox operation the prefetch uses. */
type PrefetchSandbox = Pick<Experimental_SandboxSession, "spawn">;

/**
 * Starts reading DuckDB and the compacted database into the sandbox's file cache.
 *
 * @param sandbox - Newly opened session sandbox with the mirror Drive mounted.
 * @returns Once the background process has started; it is never awaited.
 * @remarks Never throws, because a failed sandbox initialization makes eve delete the sandbox and retry. A resumed sandbox does not rerun initialization, so its first query reads from the Drive.
 */
export const prefetchMirror = async (
  sandbox: PrefetchSandbox
): Promise<void> => {
  try {
    await sandbox.spawn({ command: MIRROR_PREFETCH_COMMAND });
  } catch (error) {
    console.warn("contentful.mirror_prefetch_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
