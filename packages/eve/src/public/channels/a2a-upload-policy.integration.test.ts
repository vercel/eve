import type { UserContent } from "ai";
import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { requestPublicUrl } from "#execution/web-fetch/request.js";
import { stageAttachmentsToSandbox } from "#harness/attachment-staging.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { none } from "#public/channels/auth.js";
import { a2aChannel } from "#public/channels/a2a.js";

vi.mock("#execution/web-fetch/request.js", () => ({ requestPublicUrl: vi.fn() }));

/**
 * The A2A channel's own adapter holds staged files to its upload policy. Intake only sees a
 * file's declared type and, for a URL, no size at all; staging sees the downloaded bytes.
 */
describe("a2aChannel upload policy at staging", () => {
  it("caps URL downloads at maxBytes and refuses bytes whose real type the policy excludes", async () => {
    vi.mocked(requestPublicUrl).mockResolvedValueOnce(
      new Response(Buffer.alloc(65, 0x41), { headers: { "content-type": "image/png" } }),
    );
    const channel = a2aChannel({
      auth: none(),
      uploadPolicy: { allowedMediaTypes: ["image/*"], maxBytes: 64 },
    });
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
    const sandbox = mockSandbox({ id: "sbx_a2a_policy" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      // A URL intake can't size: the download is capped and its bytes checked.
      {
        data: "https://example.com/big.png",
        filename: "big.png",
        mediaType: "image/png",
        type: "file",
      },
      // Declared as an allowed image, but the bytes are a PDF.
      {
        data: Buffer.from("%PDF-1.7\n%\u00e2\u00e3\n", "latin1"),
        filename: "scan.png",
        mediaType: "image/png",
        type: "file",
      },
      // An allowed image within the limit is staged.
      { data: pngBytes(1, 1), filename: "dot.png", mediaType: "image/png", type: "file" },
    ];

    const staged = (await runtime.runAsSession({ channel: channel.adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;

    expect(vi.mocked(requestPublicUrl)).toHaveBeenCalledWith(
      "https://example.com/big.png",
      expect.objectContaining({ maxResponseSize: 64 }),
    );
    expect(staged.slice(0, 2)).toEqual([
      expect.objectContaining({ text: expect.stringContaining("big.png was not accepted") }),
      expect.objectContaining({ text: expect.stringContaining("scan.png was not accepted") }),
    ]);
    expect(sandbox.writes).toHaveLength(1);
  });
});
