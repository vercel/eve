import { describe, expect, it, vi } from "vitest";

import {
  collectTelegramFileParts,
  createTelegramFetchFile,
  createTelegramFileUrl,
} from "#public/channels/telegram/attachments.js";

describe("collectTelegramFileParts", () => {
  it("emits URL-backed file parts and applies the upload policy", () => {
    const parts = collectTelegramFileParts(
      [
        {
          fileId: "photo-id",
          fileName: "photo.jpg",
          kind: "photo",
          mediaType: "image/jpeg",
          size: 100,
        },
        {
          fileId: "pdf-id",
          fileName: "report.pdf",
          kind: "document",
          mediaType: "application/pdf",
          size: 100,
        },
      ],
      { allowedMediaTypes: ["image/*"], maxBytes: 1024 },
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      filename: "photo.jpg",
      mediaType: "image/jpeg",
      type: "file",
    });
    expect(String(parts[0]!.data)).toContain("telegram-file:");
  });
});

describe("createTelegramFetchFile", () => {
  it("resolves getFile and downloads bytes from Telegram's file endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { file_path: "documents/report.pdf" } }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("PDF", { headers: { "content-type": "application/pdf" } }),
      );

    const fetchFile = createTelegramFetchFile({
      api: { apiBaseUrl: "https://telegram.example", fetch: fetchMock },
      credentials: { botToken: "123456:ABCDEF" },
      policy: { allowedMediaTypes: ["application/pdf"], maxBytes: 1024 },
    });

    const result = await fetchFile(
      String(
        createTelegramFileUrl({
          fileId: "file-id",
          filename: "report.pdf",
          mediaType: "application/pdf",
        }),
      ),
    );

    expect(result).toMatchObject({
      filename: "report.pdf",
      mediaType: "application/pdf",
    });
    expect(result?.bytes.toString("utf8")).toBe("PDF");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://telegram.example/bot123456:ABCDEF/getFile",
      "https://telegram.example/file/bot123456:ABCDEF/documents/report.pdf",
    ]);
  });

  it("returns null for non-Telegram file URLs", async () => {
    const fetchFile = createTelegramFetchFile({
      credentials: { botToken: "bot-token" },
      policy: { allowedMediaTypes: "*", maxBytes: 1024 },
    });

    await expect(fetchFile("https://example.com/file.png")).resolves.toBeNull();
  });
});
