import type { SandboxSession } from "eve/sandbox";
import { Bash } from "just-bash";
import { describe, expect, it, vi } from "vitest";

import { identifyAssetFile, MAX_ASSET_FILE_BYTES } from "./files";
import { sandboxAssetReader } from "./sandbox-files";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex");

/* A just-bash sandbox whose readFile, like eve's SandboxSession, resolves null for a missing file. */
const fixture = (path = "/workspace/.eve/attachments/image.png") => {
  const bash = new Bash({ files: { [path]: png } });
  const readFile = vi.fn(async ({ path: filePath }: { path: string }) => {
    if (!(await bash.fs.exists(filePath))) {
      return null;
    }
    const bytes = await bash.fs.readFileBuffer(filePath);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  });
  const sandbox: Pick<SandboxSession, "run" | "readFile"> = {
    readFile,
    run: ({ command }) => bash.exec(command),
  };
  return {
    bash,
    read: sandboxAssetReader(async () => await sandbox),
    readFile,
  };
};

describe("reading original Slack attachments", () => {
  it("reads exact bytes after resolving the path on the local sandbox backend", async () => {
    const f = fixture();
    expect(await f.read("/workspace/.eve/attachments/image.png")).toEqual(png);
  });

  it("quotes filenames so shell syntax stays literal", async () => {
    const path = "/workspace/.eve/attachments/it's $(echo other).png";
    const f = fixture(path);
    expect(await f.read(path)).toEqual(png);
    expect(f.readFile).toHaveBeenCalledExactlyOnceWith({ path });
  });

  it("refuses symlinks escaping the attachments directory", async () => {
    const f = fixture();
    await f.bash.fs.writeFile("/workspace/private.png", png);
    await f.bash.exec(
      "ln -s /workspace/private.png /workspace/.eve/attachments/link.png"
    );
    await expect(
      f.read("/workspace/.eve/attachments/link.png")
    ).rejects.toThrow("outside");
    expect(f.readFile).not.toHaveBeenCalled();
  });

  it("refuses paths outside the attachments directory before sandbox access", async () => {
    const getSandbox = vi.fn();
    await expect(sandboxAssetReader(getSandbox)("/etc/passwd")).rejects.toThrow(
      "attachments"
    );
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("reports an attachment missing from the sandbox", async () => {
    const f = fixture();
    const path = "/workspace/.eve/attachments/missing.png";
    await expect(f.read(path)).rejects.toThrow("no longer available");
    expect(f.readFile).toHaveBeenCalledExactlyOnceWith({ path });
  });

  it("cancels the stream as soon as the file exceeds the limit", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const read = sandboxAssetReader(
      async () =>
        await {
          readFile: async () =>
            await new ReadableStream<Uint8Array>(
              {
                cancel,
                pull(controller) {
                  chunks += 1;
                  controller.enqueue(new Uint8Array(MAX_ASSET_FILE_BYTES / 2));
                },
              },
              { highWaterMark: 0 }
            ),
          run: async () =>
            await {
              exitCode: 0,
              stderr: "",
              stdout: "/workspace/.eve/attachments/big.png\n",
            },
        }
    );
    await expect(read("/workspace/.eve/attachments/big.png")).rejects.toThrow(
      "20 MiB"
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBe(3);
  });
});

describe("image type validation", () => {
  it.each([
    ["image/png", png],
    ["image/jpeg", Buffer.from("ffd8ffe00010", "hex")],
    ["image/gif", Buffer.from("GIF89a1234")],
    ["image/webp", Buffer.from("RIFF1234WEBPdata")],
    ["image/avif", Buffer.from("0000ftypavifdata")],
  ])("accepts %s signatures", (contentType, bytes) => {
    expect(identifyAssetFile(bytes, contentType).size).toBe(bytes.byteLength);
  });

  it("identifies files by the SHA-256 of their exact bytes", () => {
    expect(identifyAssetFile(png, "image/png")).toEqual({
      sha256:
        "1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24",
      size: 12,
    });
  });
});
