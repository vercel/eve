/**
 * Uploads a local folder to the project's Vercel Drive. The `drive:upload`
 * command parses its arguments and calls {@link uploadFolder}.
 *
 * @packageDocumentation
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  DriveBusyError,
  resolveDrivePath,
  withWritableDrive,
} from "../../agent/lib/drive.ts";

/** Files read and written per `writeFiles` call, so only one batch of contents is in memory at a time. */
export const WRITE_BATCH = 50;

/**
 * A local file and the absolute Drive path it uploads to.
 */
export interface UploadFile {
  drivePath: string;
  localPath: string;
}

/**
 * Maps each local file in a folder, recursively, to its Drive path.
 *
 * @param folder - Local folder to read.
 * @param prefix - Drive-relative folder to upload into, or undefined for the Drive root.
 * @returns The files to upload, sorted by Drive path, and how many symlinks or special files were skipped.
 * @throws {@link Error} When a file's Drive path is invalid.
 * @remarks Paths with a segment that starts with `.` are skipped silently and aren't counted.
 */
export const listUploadFiles = async (
  folder: string,
  prefix?: string
): Promise<{ files: UploadFile[]; skipped: number }> => {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  const files: UploadFile[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const localPath = path.join(entry.parentPath, entry.name);
    const segments = path.relative(folder, localPath).split(path.sep);
    if (segments.some((segment) => segment.startsWith("."))) {
      continue;
    }
    if (!entry.isFile()) {
      skipped += entry.isDirectory() ? 0 : 1;
      continue;
    }
    const relativePath = segments.join("/");
    files.push({
      drivePath: resolveDrivePath(
        prefix === undefined ? relativePath : `${prefix}/${relativePath}`
      ),
      localPath,
    });
  }
  files.sort((a, b) => a.drivePath.localeCompare(b.drivePath));
  return { files, skipped };
};

/**
 * Uploads every file in a folder to the Drive in one read-write session.
 *
 * @param options - The local folder, and an optional Drive-relative prefix to upload into.
 * @returns The Drive paths written, and how many symlinks or special files were skipped.
 * @throws {@link Error} When the folder doesn't exist or isn't a folder, the prefix or a file's Drive path is invalid, or the folder has no files to upload.
 * @throws {@link DriveBusyError} When another sandbox holds the Drive's read-write mount.
 * @remarks Trailing slashes are stripped from the prefix, and the prefix is validated before any file is read. Files are read and written in batches of {@link WRITE_BATCH}, one batch at a time.
 */
export const uploadFolder = async ({
  folder,
  prefix,
}: {
  folder: string;
  prefix?: string;
}): Promise<{ paths: string[]; skipped: number }> => {
  const folderStats = await stat(folder).catch(() => null);
  if (folderStats === null || !folderStats.isDirectory()) {
    throw new Error(`${folder} is not a folder.`);
  }
  const normalizedPrefix = prefix?.replace(/\/+$/u, "");
  if (normalizedPrefix !== undefined) {
    resolveDrivePath(normalizedPrefix);
  }

  const { files, skipped } = await listUploadFiles(folder, normalizedPrefix);
  if (files.length === 0) {
    throw new Error(`No files found in ${folder}.`);
  }

  await withWritableDrive(async (workspace) => {
    for (let offset = 0; offset < files.length; offset += WRITE_BATCH) {
      const batch = files.slice(offset, offset + WRITE_BATCH);
      // oxlint-disable-next-line eslint/no-await-in-loop
      const contents = await Promise.all(
        batch.map(async ({ drivePath, localPath }) => ({
          content: await readFile(localPath),
          path: drivePath,
        }))
      );
      // oxlint-disable-next-line eslint/no-await-in-loop
      await workspace.writeFiles(contents);
    }
  });

  return { paths: files.map(({ drivePath }) => drivePath), skipped };
};

/**
 * Formats an upload failure as a one-line message for the terminal.
 *
 * @param error - The error thrown by {@link uploadFolder}.
 * @returns The error's message, with a retry hint when the Drive is busy.
 */
export const describeUploadError = (error: Error): string =>
  error instanceof DriveBusyError
    ? `${error.message} Try again when it finishes.`
    : error.message;
