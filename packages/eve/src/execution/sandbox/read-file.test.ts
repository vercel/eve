import { describe, expect, it } from "vitest";

import { executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { readFile } from "#tools/provided/read-file.js";

describe("read_file images", () => {
  it("shows an image file to the model as an image part", async () => {
    const png = pngBytes(32, 32, 64);
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({ content: png, path: "/workspace/chart.png" });

    const output = await executeReadFileOnSandbox(sandbox.session, {
      filePath: "/workspace/chart.png",
    });

    expect(await readFile.toModelOutput?.(output)).toEqual({
      type: "content",
      value: [
        { text: `Image /workspace/chart.png (image/png, ${png.byteLength} bytes).`, type: "text" },
        {
          data: { data: png.toString("base64"), type: "data" },
          mediaType: "image/png",
          type: "file",
        },
      ],
    });
  });

  it("rejects images too large to show inline", async () => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({
      content: pngBytes(4000, 4000, 3 * 1024 * 1024),
      path: "/workspace/photo.png",
    });

    await expect(
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/photo.png" }),
    ).rejects.toThrow("read_file shows images up to 3 MiB");
  });
});
