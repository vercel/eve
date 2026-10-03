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
  it("keeps image bytes out of the raw output and shows them to the model", async () => {
    const png = pngBytes(32, 32, 64);
    const sandbox = mockSandbox();
    await sandbox.session.writeBinaryFile({ content: png, path: "/workspace/chart.png" });

    const output = await executeReadFileOnSandbox(sandbox.session, {
      filePath: "/workspace/chart.png",
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
        { text: `Image /workspace/chart.png (image/png, ${png.byteLength} bytes).`, type: "text" },
        {
          data: { data: png.toString("base64"), type: "data" },
          filename: "chart.png",
          mediaType: "image/png",
          type: "file",
        },
      ],
    });
  });

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
