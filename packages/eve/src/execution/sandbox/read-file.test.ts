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
      expect(output.file).toEqual({
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
    expect(output.file).toMatchObject({ mediaType: "image/png" });
  });

  it.each([
    ["JPEG", Buffer.from([255, 216, 255, 217]), "image/jpeg"],
    ["GIF87a", Buffer.from("GIF87a\x01\0\x01\0", "latin1"), "image/gif"],
    ["GIF89a", Buffer.from("GIF89a\x01\0\x01\0", "latin1"), "image/gif"],
    ["WebP", Buffer.from("RIFF\0\0\0\0WEBP"), "image/webp"],
  ])("detects %s without a filename suffix", async (_label, bytes, mediaType) => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({ path: "/workspace/image", content: bytes });
    const output = await executeReadFileOnSandbox(sandbox.session, {
      filePath: "/workspace/image",
    });
    expect(output.file).toMatchObject({ mediaType, size: bytes.byteLength });
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

  it.each([
    ["an empty file", ""],
    ["a truncated WebP header", "RIFF"],
    ["text that starts with a GIF signature", "GIF89a is the most common GIF version.\n"],
  ])("reads %s as text", async (_label, content) => {
    const sandbox = mockSandbox();
    await sandbox.session.writeTextFile({ path: "/workspace/file", content });
    const output = await contextStorage.run(sandboxContext(sandbox), () =>
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/file" }),
    );
    expect(output.file).toBeUndefined();
    expect(output.totalLines).toBe(content === "" ? 0 : 1);
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

  it("withholds an image replaced between execute and toModelOutput", async () => {
    const sandbox = mockSandbox();
    const path = "/workspace/chart.png";
    await sandbox.session.writeBinaryFile({ content: pngBytes(8, 8), path });
    const output = await executeReadFileOnSandbox(sandbox.session, { filePath: path });

    await sandbox.session.writeBinaryFile({ content: pngBytes(8, 8, 1024), path });
    const modelOutput = await contextStorage.run(sandboxContext(sandbox), async () =>
      readFile.toModelOutput?.(output),
    );

    expect(modelOutput).toEqual({
      type: "text",
      value: `${output.content} The file changed after it was read; read it again.`,
    });
  });

  it("rejects images wider than providers accept", async () => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({
      content: pngBytes(8001, 10),
      path: "/workspace/wide.png",
    });

    await expect(
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/wide.png" }),
    ).rejects.toThrow("8001x10 pixels");
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

describe("read_file PDFs", () => {
  const pdf = Buffer.from(
    "%PDF-1.4\n%\xe2\xe3\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page>>endobj\n%%EOF\n",
    "latin1",
  );

  it("shows a PDF to the model as a file, whatever its name", async () => {
    const sandbox = mockSandbox();
    const path = "/workspace/.eve/attachments/abc/report";
    await sandbox.session.writeBinaryFile({ content: pdf, path });

    const output = await executeReadFileOnSandbox(sandbox.session, { filePath: path });
    const modelOutput = await contextStorage.run(sandboxContext(sandbox), async () =>
      readFile.toModelOutput?.(output),
    );

    expect(output.file).toEqual({ mediaType: "application/pdf", pages: 1, size: pdf.byteLength });
    expect(modelOutput).toEqual({
      type: "content",
      value: [
        { text: `PDF ${path} (application/pdf, ${pdf.byteLength} bytes, 1 page).`, type: "text" },
        {
          data: { data: pdf.toString("base64"), type: "data" },
          filename: "report",
          mediaType: "application/pdf",
          type: "file",
        },
      ],
    });
  });

  it("reads text that mentions the PDF header as text", async () => {
    const sandbox = mockSandbox();
    const content = "# Notes\nEvery PDF starts with %PDF- followed by its version.\n";
    await sandbox.session.writeTextFile({ content, path: "/workspace/notes.md" });

    const output = await contextStorage.run(sandboxContext(sandbox), () =>
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/notes.md" }),
    );

    expect(output.file).toBeUndefined();
    expect(output.totalLines).toBe(2);
  });

  it("rejects PDFs over 20 MiB", async () => {
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({
      content: Buffer.concat([pdf, Buffer.alloc(20 * 1024 * 1024)]),
      path: "/workspace/big.pdf",
    });

    await expect(
      executeReadFileOnSandbox(sandbox.session, { filePath: "/workspace/big.pdf" }),
    ).rejects.toThrow("read_file shows PDFs up to 20 MiB");
  });
});
