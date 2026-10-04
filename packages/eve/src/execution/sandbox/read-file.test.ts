import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { stageToolResultMedia } from "#harness/attachment-staging.js";
import { decodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { readFile } from "#tools/provided/read-file.js";

function sandboxContext(sandbox: ReturnType<typeof mockSandbox>): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, sandbox.access);
  return ctx;
}

function toolResultMessage(file: Record<string, unknown>): ModelMessage {
  return {
    content: [
      {
        output: { type: "content", value: [file] },
        toolCallId: "call-1",
        toolName: "browser_screenshot",
        type: "tool-result",
      },
    ],
    role: "tool",
  } as ModelMessage;
}

function stagedPath(message: ModelMessage | undefined): string | undefined {
  const part = message?.role === "tool" ? message.content[0] : undefined;
  const file =
    part?.type === "tool-result" && part.output.type === "content"
      ? part.output.value[0]
      : undefined;
  return file?.type === "file" && file.data.type === "url"
    ? decodeSandboxRef(file.data.url).path
    : undefined;
}

describe("read_file images", () => {
  it.each(["chart.png", "chart", "chart.bin", "chart.jpg"])(
    "keeps image bytes out of raw output and shows %s with its detected media type",
    async (filename) => {
      const png = pngBytes(32, 32, 64);
      const sandbox = mockSandbox();
      const path = `/workspace/${filename}`;
      await sandbox.session.writeBinaryFile({ content: png, path });

      const output = await executeReadFileOnSandbox(sandbox.session, {
        filePath: path,
      });
      const modelOutput = await contextStorage.run(sandboxContext(sandbox), async () =>
        readFile.toModelOutput?.(output),
      );

      // The raw output feeds action.result, so it carries metadata only.
      expect(output.image).toEqual({
        height: 32,
        mediaType: "image/png",
        size: png.byteLength,
        width: 32,
      });
      expect(modelOutput).toEqual({
        type: "content",
        value: [
          { text: `Image ${path} (image/png, ${png.byteLength} bytes).`, type: "text" },
          {
            data: { data: png.toString("base64"), type: "data" },
            filename,
            mediaType: "image/png",
            type: "file",
          },
        ],
      });
    },
  );

  it("reopens a nameless tool image from the path its compaction stub names", async () => {
    const png = pngBytes(16, 16);
    const sandbox = mockSandbox();

    // MCP image blocks reach eve as file parts without a filename.
    const [message] = await contextStorage.run(sandboxContext(sandbox), () =>
      stageToolResultMedia([
        toolResultMessage({
          data: { data: png.toString("base64"), type: "data" },
          mediaType: "image/png",
          type: "file",
        }),
      ]),
    );
    const path = stagedPath(message) ?? "";

    expect(path).toMatch(/^\/workspace\/\.eve\/attachments\/[0-9a-f]{16}\/file-[0-9a-f]{16}\.png$/);
    const output = await executeReadFileOnSandbox(sandbox.session, { filePath: path });
    expect(output.image).toMatchObject({ mediaType: "image/png" });
  });

  it.each([
    [Buffer.from([255, 216, 255, 217]), "image/jpeg"],
    [Buffer.from("GIF87a"), "image/gif"],
    [Buffer.from("GIF89a"), "image/gif"],
    [Buffer.from("RIFF\0\0\0\0WEBP"), "image/webp"],
  ])("detects %s as %s without a filename suffix", async (bytes, mediaType) => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({ path: "/workspace/image", content: bytes });
    const output = await executeReadFileOnSandbox(sandbox.session, {
      filePath: "/workspace/image",
    });
    expect(output.image).toMatchObject({ mediaType, size: bytes.byteLength });
  });

  it("reads text with an image suffix using normal pagination", async () => {
    const sandbox = mockSandbox();
    await sandbox.session.writeTextFile({
      path: "/workspace/notes.png",
      content: "hello\nworld\n",
    });
    const output = await contextStorage.run(sandboxContext(sandbox), () =>
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/notes.png", limit: 1 }),
    );
    expect(output).toEqual({
      content: "1: hello",
      nextOffset: 2,
      path: "/workspace/notes.png",
      totalLines: 2,
      truncated: true,
    });
  });

  it("rejects unsupported binary files instead of rendering them as images", async () => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({
      path: "/workspace/audio.png",
      content: Buffer.from("RIFF\0\0\0\0WAVE"),
    });
    await expect(
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/audio.png" }),
    ).rejects.toThrow("binary file");
  });

  it.each(["photo.png", "photo"])("rejects oversized images named %s", async (filename) => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({
      content: pngBytes(4000, 4000, 3 * 1024 * 1024),
      path: `/workspace/${filename}`,
    });

    await expect(
      executeReadFileOnSandbox(sandbox.session, { filePath: `/workspace/${filename}` }),
    ).rejects.toThrow("read_file shows images up to 3 MiB");
  });
});
