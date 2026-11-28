import { getToken } from "@vercel/connect";
import { rebuildSandboxTemplate } from "eve/sandbox/vercel";
import { defineSchedule } from "eve/schedules";

import { refresh, type RepoSnapshotOptions, type RepoSnapshotResult } from "./repo-snapshot.ts";

export type { RepoSnapshotOptions, RepoSnapshotResult };

/**
 * Brings a repository checked out in the agent's Vercel sandbox template up to the head of a
 * branch. It reads the head from GitHub and returns at once when the template already has it.
 * Otherwise it opens a throwaway sandbox from the template, fetches the head, runs `install` when
 * a lockfile changed, and publishes the result so sessions started afterwards open from it. A
 * failed fetch or install leaves the template as it was. Call it from a schedule, a webhook channel
 * or a tool; sessions already running keep the code they started with.
 */
export async function refreshRepoSnapshot(
  options: RepoSnapshotOptions,
): Promise<RepoSnapshotResult> {
  return await refresh(options, { fetch, getToken, rebuild: rebuildSandboxTemplate });
}

/** Options for {@link repoSnapshotSchedule}. */
export interface RepoSnapshotScheduleOptions extends RepoSnapshotOptions {
  /** How often to check the branch. Defaults to every 15 minutes. */
  readonly cron?: string;
}

/**
 * A schedule that calls {@link refreshRepoSnapshot}. Export it as the default of a file in
 * `agent/schedules/` so new sessions start on a checkout at most one interval plus one rebuild
 * behind the branch.
 */
export function repoSnapshotSchedule({
  cron = "*/15 * * * *",
  ...options
}: RepoSnapshotScheduleOptions) {
  return defineSchedule({
    cron,
    async run() {
      await refreshRepoSnapshot(options);
    },
  });
}
