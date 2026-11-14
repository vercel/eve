/**
 * Vercel Drive adapter for the Contentful mirror. The sync runs in this process and
 * writes through a short-lived sandbox, so the Contentful token never enters it.
 *
 * @packageDocumentation
 */

import { Drive, Sandbox } from "@vercel/sandbox";

import { buildMirrorDatabase } from "./database";
import type { DatabaseSandbox } from "./database";
import { MIRROR_DRIVE_NAME, MIRROR_PATH, MIRROR_REGION } from "./files";
import { syncContentfulMirror } from "./sync";
import type { MirrorSyncMode, MirrorWorkspace } from "./sync";

/* Files removed per `rm` command, keeping argument lists short. */
const REMOVE_BATCH = 200;

/* Upper bound on one sync; the sandbox, and its read-write mount, end by then. */
const SYNC_SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;

/* The sandbox operations the mirror workspace uses. */
interface MirrorSandbox extends DatabaseSandbox {
  readFileToBuffer: (file: { path: string }) => Promise<Buffer | null>;
}

const run = async (sandbox: MirrorSandbox, command: string, args: string[]) => {
  const result = await sandbox.runCommand(command, args);
  if (result.exitCode !== 0) {
    const completed1 = await result.stderr();
    throw new Error(
      `${command} failed in the mirror sandbox (exit ${result.exitCode}): ${completed1.trim()}`
    );
  }
  return result.stdout();
};

/**
 * Adapts a sandbox mounted at MIRROR_PATH to the storage operations required by mirror sync.
 *
 * @param sandbox - Sandbox file and command API with the mirror Drive already mounted.
 * @returns A workspace that lists, reads, batches removals, and writes mirror files.
 */
export const sandboxMirrorWorkspace = (
  sandbox: MirrorSandbox
): MirrorWorkspace => ({
  buildDatabase: () => buildMirrorDatabase(sandbox),
  async listEntryFiles() {
    const stdout = await run(sandbox, "find", [
      MIRROR_PATH,
      "-mindepth",
      "2",
      "-maxdepth",
      "2",
      "-type",
      "f",
      "-name",
      "*.md",
    ]);
    return stdout.split("\n").filter(Boolean);
  },
  async readText(path) {
    const buffer = await sandbox.readFileToBuffer({ path });
    return buffer ? buffer.toString("utf-8") : null;
  },
  async remove(paths) {
    for await (const offset of Array.from(
      { length: Math.ceil(paths.length / REMOVE_BATCH) },
      (_, index) => index * REMOVE_BATCH
    )) {
      await run(sandbox, "rm", [
        "-f",
        "--",
        ...paths.slice(offset, offset + REMOVE_BATCH),
      ]);
    }
  },
  async writeFiles(files) {
    const directories = [
      ...new Set(files.map(({ path }) => path.slice(0, path.lastIndexOf("/")))),
    ];
    await run(sandbox, "mkdir", ["-p", "--", ...directories]);
    await sandbox.writeFiles(files);
  },
});

/**
 * Mounts the mirror Drive read-write for the lifetime of one sync callback.
 *
 * @typeParam T - Value returned by the sync callback.
 * @param sync - Callback that receives an isolated workspace with the Drive mounted.
 * @returns The callback result, or null when another sandbox already holds the write mount.
 * @remarks The sandbox denies network access and is stopped when the callback settles; CMA requests run in this process.
 */
export const withMirrorDrive = async <T>(
  sync: (workspace: MirrorWorkspace) => Promise<T>
): Promise<T | null> => {
  const drive = await Drive.getOrCreate({
    name: MIRROR_DRIVE_NAME,
    region: MIRROR_REGION,
  });
  if (drive.currentSessionId) {
    console.info("contentful.mirror_sync_skipped", {
      reason: "drive-in-use",
      sessionId: drive.currentSessionId,
    });
    return null;
  }
  const sandbox = await Sandbox.create({
    mounts: { [MIRROR_PATH]: drive },
    networkPolicy: "deny-all",
    persistent: false,
    region: MIRROR_REGION,
    tags: { application: "contentful-agent" },
    timeout: SYNC_SANDBOX_TIMEOUT_MS,
  });
  try {
    return await sync(sandboxMirrorWorkspace(sandbox));
  } finally {
    await sandbox.stop();
  }
};

/**
 * Runs one scheduled mirror update and records failures without advancing its manifest.
 *
 * @param mode - Full reconciliation or incremental update requested by the schedule.
 * @returns Completes after the sync, a busy-Drive skip, or a logged failure.
 * @remarks Failed runs leave the previous manifest available for the next incremental retry.
 */
export const runScheduledMirrorSync = async (
  mode: MirrorSyncMode
): Promise<void> => {
  try {
    await withMirrorDrive((workspace) =>
      syncContentfulMirror({ mode, workspace })
    );
  } catch (error) {
    console.error("contentful.mirror_sync_failed", {
      message: error instanceof Error ? error.message : String(error),
      mode,
    });
  }
};
