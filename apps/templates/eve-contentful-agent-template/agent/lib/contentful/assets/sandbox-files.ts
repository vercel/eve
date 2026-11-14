/* eve adapter for bounded reads of attachments from the current session sandbox. */
import type { SandboxSession } from "eve/sandbox";

import { isAssetFilePath, MAX_ASSET_FILE_BYTES } from "./files";
import type { ReadAssetFile } from "./files";

/**
 * Creates an attachment reader that resolves symlinks inside the current session sandbox.
 *
 * @param getSandbox - Opens or retrieves the session's sandbox file and command API.
 * @returns A reader limited to attachment-directory files of at most 20 MiB.
 * @remarks Application-host files are never read; resolved paths must remain in the attachment directory.
 */
export const sandboxAssetReader =
  (
    getSandbox: () => Promise<Pick<SandboxSession, "run" | "readFile">>
  ): ReadAssetFile =>
  async (path) => {
    if (!isAssetFilePath(path)) {
      throw new Error("Choose an image under /workspace/.eve/attachments.");
    }
    const sandbox = await getSandbox();
    const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
    const resolved = await sandbox.run({
      command: `readlink -f -- ${quotedPath}`,
    });
    const realPath = resolved.stdout.endsWith("\n")
      ? resolved.stdout.slice(0, -1)
      : resolved.stdout;
    if (resolved.exitCode !== 0 || !isAssetFilePath(realPath)) {
      throw new Error(
        "The attachment is missing or resolves outside its directory."
      );
    }
    const stream = await sandbox.readFile({ path: realPath });
    if (!stream) {
      throw new Error("The attachment is no longer available in this session.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_ASSET_FILE_BYTES) {
        throw new Error("Attachment exceeds the 20 MiB image limit.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  };
