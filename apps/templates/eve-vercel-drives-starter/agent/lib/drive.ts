/**
 * Vercel Drive access for the agent. Sessions mount the Drive as a read-only
 * snapshot; writes run in this process through a short-lived sandbox that
 * holds the Drive's exclusive read-write mount.
 *
 * @remarks Imports only `@vercel/sandbox`, so the upload script can load this module directly with Node.
 * @packageDocumentation
 */

import { Drive, Sandbox } from "@vercel/sandbox";

/**
 * Reads an optional environment variable.
 *
 * @param name - Environment variable name.
 * @param fallback - Value used when the variable is unset or empty.
 * @returns The variable's value, or `fallback`.
 */
const envOr = (name: string, fallback: string) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

/**
 * Drive name, unique within the Vercel project. Override with `DRIVE_NAME`.
 *
 * @defaultValue `"eve-drive"`
 */
export const DRIVE_NAME = envOr("DRIVE_NAME", "eve-drive");

/**
 * Drive region. Override with `DRIVE_REGION`.
 *
 * @defaultValue `"iad1"`
 * @remarks Sandboxes that mount the Drive must run in the same region, and a Drive's region can't change after creation.
 */
export const DRIVE_REGION = envOr("DRIVE_REGION", "iad1");

/** Absolute mount path of the Drive in session and write sandboxes. */
export const DRIVE_PATH = "/drive";

/** Upper bound on one write; the sandbox, and its read-write mount, end by then. */
const WRITE_SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Thrown when another sandbox already holds the Drive's read-write mount.
 */
export class DriveBusyError extends Error {
  /** Vercel Sandbox session currently attached to the Drive. */
  readonly sessionId: string;

  /**
   * @param sessionId - Vercel Sandbox session currently attached to the Drive.
   */
  constructor(sessionId: string) {
    super(
      `Drive "${DRIVE_NAME}" is in use by Vercel Sandbox session ${sessionId}.`
    );
    this.name = "DriveBusyError";
    this.sessionId = sessionId;
  }
}

/**
 * A file addressed by its absolute path under DRIVE_PATH.
 */
interface DriveFile {
  /** Text is written as UTF-8; bytes are written unchanged. */
  content: string | Uint8Array;
  /** Absolute path under DRIVE_PATH, such as one returned by {@link resolveDrivePath}. */
  path: string;
}

/**
 * Write operations available while the Drive is mounted read-write.
 */
export interface DriveWorkspace {
  /** Deletes files by absolute path; missing files are ignored. */
  remove: (paths: string[]) => Promise<void>;
  /** Writes files, creating parent directories as needed. */
  writeFiles: (files: DriveFile[]) => Promise<void>;
}

/** The subset of the sandbox API the Drive workspace uses. */
interface DriveSandbox {
  runCommand: (
    command: string,
    args: string[]
  ) => Promise<{
    exitCode: number;
    stderr: () => Promise<string>;
    stdout: () => Promise<string>;
  }>;
  writeFiles: (files: DriveFile[]) => Promise<void>;
}

/** Longest path segment most Linux filesystems accept, in bytes. */
const MAX_SEGMENT_BYTES = 255;

/**
 * Runs a command in the sandbox and returns its output.
 *
 * @param sandbox - Sandbox to run the command in.
 * @param command - Executable name.
 * @param args - Command arguments.
 * @returns The command's stdout.
 * @throws {@link Error} When the command exits nonzero; the message includes its stderr.
 */
const run = async (sandbox: DriveSandbox, command: string, args: string[]) => {
  const result = await sandbox.runCommand(command, args);
  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(
      `${command} failed in the Drive sandbox (exit ${result.exitCode}): ${stderr.trim()}`
    );
  }
  return await result.stdout();
};

/**
 * Resolves a Drive-relative path to its absolute mount path.
 *
 * @param relative - Slash-separated path relative to the Drive root, such as `notes/today.md`.
 * @returns The absolute path under DRIVE_PATH.
 * @throws {@link Error} When the path is absolute, empty, or contains a NUL byte, or a segment is empty, `.`, `..`, longer than 255 bytes, or starts or ends with whitespace.
 */
export const resolveDrivePath = (relative: string): string => {
  const segments = relative.split("/");
  if (
    relative.includes("\0") ||
    segments.some(
      (segment) =>
        ["", ".", ".."].includes(segment) ||
        segment.trim() !== segment ||
        Buffer.byteLength(segment) > MAX_SEGMENT_BYTES
    )
  ) {
    throw new Error(
      `Invalid Drive path "${relative}". Use a relative path like "notes/today.md".`
    );
  }
  return `${DRIVE_PATH}/${segments.join("/")}`;
};

/**
 * Adapts a sandbox with the Drive mounted at DRIVE_PATH to the Drive workspace.
 *
 * @param sandbox - Sandbox file and command API with the Drive already mounted.
 * @returns A workspace that writes and deletes files.
 */
export const sandboxDriveWorkspace = (
  sandbox: DriveSandbox
): DriveWorkspace => ({
  async remove(paths) {
    if (paths.length === 0) {
      return;
    }
    await run(sandbox, "rm", ["-f", "--", ...paths]);
  },
  async writeFiles(files) {
    if (files.length === 0) {
      return;
    }
    const directories = [
      ...new Set(files.map(({ path }) => path.slice(0, path.lastIndexOf("/")))),
    ];
    await run(sandbox, "mkdir", ["-p", "--", ...directories]);
    await sandbox.writeFiles(files);
  },
});

/**
 * Opens the Drive, creating it on first use.
 *
 * @returns The project's Drive in DRIVE_REGION.
 */
const getDrive = async () =>
  await Drive.getOrCreate({ name: DRIVE_NAME, region: DRIVE_REGION });

/**
 * Checks that no sandbox is attached to the Drive.
 *
 * @param drive - Drive whose current session to check.
 * @throws {@link DriveBusyError} When another sandbox is attached to the Drive.
 */
const assertNotBusy = ({ currentSessionId }: Drive) => {
  if (currentSessionId !== undefined && currentSessionId !== "") {
    throw new DriveBusyError(currentSessionId);
  }
};

/**
 * Mounts the Drive read-write for the lifetime of one callback.
 *
 * @typeParam T - Value returned by the callback.
 * @param write - Callback that receives a workspace with the Drive mounted.
 * @returns The callback result.
 * @throws {@link DriveBusyError} When another sandbox already holds the read-write mount, including one that took it while this sandbox was starting.
 * @remarks The sandbox denies network access and is stopped when the callback settles. A failed stop is logged rather than thrown, and the sandbox's timeout releases the mount.
 */
export const withWritableDrive = async <T>(
  write: (workspace: DriveWorkspace) => Promise<T>
): Promise<T> => {
  const drive = await getDrive();
  assertNotBusy(drive);
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      mounts: { [DRIVE_PATH]: drive },
      networkPolicy: "deny-all",
      persistent: false,
      region: DRIVE_REGION,
      tags: { application: "eve-vercel-drives-starter" },
      timeout: WRITE_SANDBOX_TIMEOUT_MS,
    });
  } catch (error) {
    // Creation can fail because another writer took the mount after the check above; report that as busy.
    const current = await getDrive().catch(() => null);
    if (current !== null) {
      assertNotBusy(current);
    }
    throw error;
  }
  try {
    return await write(sandboxDriveWorkspace(sandbox));
  } finally {
    try {
      await sandbox.stop();
    } catch (error) {
      console.warn("drive.stop_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
