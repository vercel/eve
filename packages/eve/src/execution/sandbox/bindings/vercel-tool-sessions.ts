import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import type {
  VercelCreateOptions,
  VercelModule,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type {
  ToolSessionSandboxSummary,
  ToolSessionSandboxSweeper,
} from "#execution/tool-session/sandbox.js";

/** Name prefix of every keyed tool session's Vercel sandbox. */
export const VERCEL_TOOL_SESSION_NAME_PREFIX = "eve-ts-vercel-";

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["aborted", "failed", "stopped"]);

/** The fields a listed sandbox and a fetched `Sandbox` both carry. */
interface VercelSandboxRecord {
  readonly name: string;
  readonly status: string;
  readonly statusUpdatedAt?: Date | number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly updatedAt: Date | number;
}

/** Lists tool-session sandboxes by name prefix and deletes them after a fresh read. */
export function createVercelToolSessionSweeper(deps: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
}): ToolSessionSandboxSweeper {
  return {
    async list() {
      const sandboxModule = await deps.loadSandboxModule();
      const listed = await sandboxModule.Sandbox.list({
        ...(await getVercelSandboxCredentials(deps.createOptions)),
        fetch: getVercelSandboxFetch(deps.createOptions),
        namePrefix: VERCEL_TOOL_SESSION_NAME_PREFIX,
      });
      const summaries: ToolSessionSandboxSummary[] = [];
      for await (const sandbox of listed) summaries.push(summarize(sandbox));
      return summaries;
    },
    async deleteUnless(_storage, name, keep) {
      const sandbox = await getNamedVercelSandbox({
        createOptions: deps.createOptions,
        sandboxModule: await deps.loadSandboxModule(),
        sandboxName: name,
      });
      if (sandbox === null || keep(summarize(sandbox))) return false;
      await sandbox.delete({ deleteOrphanSnapshots: true });
      return true;
    },
  };
}

function summarize(sandbox: VercelSandboxRecord): ToolSessionSandboxSummary {
  return {
    lastUsedAt: Math.max(toEpochMs(sandbox.updatedAt), toEpochMs(sandbox.statusUpdatedAt)),
    name: sandbox.name,
    // Anything not settled (pending, running, stopping, snapshotting) counts as in use.
    running: !SETTLED_STATUSES.has(sandbox.status),
    sessionId: sandbox.tags?.sessionId,
  };
}

// A listing reports epoch numbers; a fetched `Sandbox` reports Dates.
function toEpochMs(value: Date | number | undefined): number {
  if (value === undefined) return 0;
  return typeof value === "number" ? value : value.getTime();
}
