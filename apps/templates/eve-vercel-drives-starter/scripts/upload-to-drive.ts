/**
 * Uploads a local folder to the project's Vercel Drive.
 *
 * Usage: `pnpm drive:upload <folder> [--prefix <drive/sub/dir>]`
 *
 * @remarks Needs Vercel credentials in `.env.local`; run `vercel link` and `vercel env pull .env.local` first.
 * @packageDocumentation
 */

import { parseArgs } from "node:util";

import { DRIVE_NAME } from "../agent/lib/drive.ts";
import { describeUploadError, uploadFolder } from "./lib/upload.ts";

const USAGE = "Usage: pnpm drive:upload <folder> [--prefix <drive/sub/dir>]";

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { prefix: { type: "string" } },
  });
  const [folder] = positionals;
  if (folder === undefined) {
    throw new Error(USAGE);
  }
  const { paths, skipped } = await uploadFolder({
    folder,
    prefix: values.prefix,
  });
  if (skipped > 0) {
    console.warn(`Skipped ${skipped} symlinks or special files.`);
  }
  console.log(
    `Uploaded ${paths.length} ${paths.length === 1 ? "file" : "files"} to Drive "${DRIVE_NAME}":`
  );
  for (const drivePath of paths) {
    console.log(`  ${drivePath}`);
  }
} catch (error) {
  console.error(
    describeUploadError(
      error instanceof Error ? error : new Error(String(error))
    )
  );
  process.exitCode = 1;
}
