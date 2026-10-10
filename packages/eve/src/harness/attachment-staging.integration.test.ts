import type { FilePart, ModelMessage, ToolResultPart, UserContent } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import {
  ATTACHMENTS_ROOT,
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
  stageToolResultMedia,
} from "#harness/attachment-staging.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { requestPublicUrl } from "#execution/web-fetch/request.js";

vi.mock("#execution/web-fetch/request.js", () => ({ requestPublicUrl: vi.fn() }));

/**
 * Integration coverage for {@link stageAttachmentsToSandbox}.
 *
 * The staging helper is the single seam the tool loop uses to push
 * inbound attachments into the sandbox before the model call. This
 * suite exercises the full plumbing — `AlsContext` → `SandboxKey` →
 * `MockSandbox` — so regressions in the harness/context handoff fail
 * here rather than silently skipping the write at runtime.
 *
 * Unit coverage of `stageAttachmentsForAdapter(content, sandbox, ctx)`
 * (no ambient context involved) lives in `attachment-staging.test.ts`.
 */

describe("stageAttachmentsToSandbox (integration)", () => {
  it("exposes the staged path to authored tools via getSandbox().readFile", async () => {
    const sandbox = mockSandbox({ id: "sbx_roundtrip" });
    const readTool = mockTool({
      name: "read_attachment",
      async execute(input, ctx) {
        const { filePath } = input as { filePath: string };
        const live = await ctx.getSandbox();
        return await live.readTextFile({ path: filePath });
      },
    });
    const runtime = await createTestRuntime({ tools: [readTool] });
    const payload = "id,name\n1,alpha\n";
    const bytes = Buffer.from(payload, "utf8");

    const content: UserContent = [
      { data: bytes, filename: "quarterly.csv", mediaType: "text/csv", type: "file" },
    ];

    const result = await runtime.runAsSession({ sandbox }, async () => {
      const staged = (await stageAttachmentsToSandbox(content)) as UserContent;
      const filePart = staged[0] as FilePart;
      const stagedPath = filePart.filename;
      if (typeof stagedPath !== "string") {
        throw new Error("Expected staged FilePart to carry a string filename.");
      }
      return await runtime.executeTool(readTool, { filePath: stagedPath });
    });

    expect(result).toBe(payload);
  });

  it("passes UserContent arrays with no FileParts through untouched", async () => {
    const sandbox = mockSandbox({ id: "sbx_no_files" });
    const runtime = await createTestRuntime();
    const content: UserContent = [{ type: "text", text: "just text" }];

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toBe(content);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("replaces each file with a note when no sandbox is bound, so history never keeps it", async () => {
    const runtime = await createTestRuntime();
    const content: UserContent = [
      { type: "text", text: "see attached" },
      { data: Buffer.from("bytes"), filename: "orphan.txt", mediaType: "text/plain", type: "file" },
      {
        data: "eve-url:telegram-file:photo",
        filename: "photo.jpg",
        mediaType: "image/jpeg",
        type: "file",
      },
    ];

    // `runAsSession` without a sandbox argument leaves SandboxKey unbound.
    const staged = await runtime.runAsSession(undefined, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toEqual([
      { type: "text", text: "see attached" },
      { text: "Attachment orphan.txt could not be stored: no sandbox is available.", type: "text" },
      { text: "Attachment photo.jpg could not be stored: no sandbox is available.", type: "text" },
    ]);
  });

  it("replaces data that is not bytes, base64, or a URL with a note", async () => {
    const sandbox = mockSandbox({ id: "sbx_unreadable" });
    const runtime = await createTestRuntime();
    // A Uint8Array that crossed a JSON boundary arrives as a plain object.
    const content: UserContent = [
      {
        data: { 0: 1, 1: 2 } as never,
        filename: "photo.png",
        mediaType: "image/png",
        type: "file",
      },
    ];

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toEqual([{ text: "Attachment photo.png could not be read.", type: "text" }]);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("dedupes repeated uploads of the same payload within one session", async () => {
    const sandbox = mockSandbox({ id: "sbx_dedupe" });
    const runtime = await createTestRuntime();
    const payload = Buffer.from("shared-payload", "utf8");

    const firstStaged = await runtime.runAsSession({ sandbox }, async () => {
      const content: UserContent = [
        { data: payload, filename: "one.txt", mediaType: "text/plain", type: "file" },
      ];
      return (await stageAttachmentsToSandbox(content)) as UserContent;
    });

    const secondStaged = await runtime.runAsSession({ sandbox }, async () => {
      const content: UserContent = [
        { data: payload, filename: "two.txt", mediaType: "text/plain", type: "file" },
      ];
      return (await stageAttachmentsToSandbox(content)) as UserContent;
    });

    const first = firstStaged[0] as FilePart;
    const second = secondStaged[0] as FilePart;
    const firstSha = /attachments\/([0-9a-f]{16})\//.exec(first.filename ?? "")?.[1];
    const secondSha = /attachments\/([0-9a-f]{16})\//.exec(second.filename ?? "")?.[1];

    expect(firstSha).toBeDefined();
    expect(firstSha).toBe(secondSha);
    expect(sandbox.writes).toHaveLength(2);
  });

  it("resolves URL FileParts via the bound adapter's fetchFile", async () => {
    const resolvedBytes = Buffer.from("resolved-ref-bytes", "utf8");
    let fetchFileCalls = 0;
    const adapter: ChannelAdapter<any> = {
      async fetchFile(url, context) {
        fetchFileCalls += 1;
        // fetchFile receives the URL string from the FilePart.
        expect(url).toBe("https://example.com/file");
        expect(context?.state).toEqual({ installationTeamId: "T_INSTALLATION" });
        return resolvedBytes;
      },
      kind: "custom-channel",
      state: { installationTeamId: "T_INSTALLATION" },
    };

    const sandbox = mockSandbox({ id: "sbx_ref" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      { type: "text", text: "what do you see?" },
      {
        data: new URL("https://example.com/file"),
        filename: "report.csv",
        mediaType: "text/csv",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    expect(fetchFileCalls).toBe(1);
    expect(staged).toHaveLength(2);
    const filePart = staged[1] as FilePart;
    expect(filePart.filename).toMatch(
      new RegExp(`^${ATTACHMENTS_ROOT.replaceAll(".", "\\.")}/[0-9a-f]{16}/report\\.csv$`),
    );
    // `data` is replaced with an eve-sandbox: ref — the bytes live in
    // the sandbox and are rehydrated at the model call site. The
    // URL is fully consumed here.
    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    const sandboxRef = decodeSandboxRef(filePart.data as URL);
    expect(sandboxRef.size).toBe(resolvedBytes.byteLength);
    expect(sandboxRef.mediaType).toBe("text/csv");
    expect(sandboxRef.path).toBe(filePart.filename);

    expect(sandbox.writes).toHaveLength(1);
    const written = sandbox.writes[0]?.content as Buffer;
    expect(written.equals(resolvedBytes)).toBe(true);
  });

  it("hands a string with any scheme to fetchFile instead of decoding it as base64", async () => {
    const urls: string[] = [];
    const adapter: ChannelAdapter<any> = {
      async fetchFile(url) {
        urls.push(url);
        return Buffer.from("stored-upload");
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_custom_scheme" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      { data: "myapp-file:abc", filename: "upload.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    expect(urls).toEqual(["myapp-file:abc"]);
    expect(decodeSandboxRef((staged[0] as FilePart).data as URL).size).toBe(
      Buffer.byteLength("stored-upload"),
    );
  });

  it("turns a link with a scheme no channel resolves into a note", async () => {
    const sandbox = mockSandbox({ id: "sbx_unknown_scheme" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      { data: "myapp-file:abc", filename: "upload.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toEqual([
      {
        text: expect.stringMatching(/^Attachment upload\.txt could not be retrieved/),
        type: "text",
      },
    ]);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("refines FilePart.mediaType when fetchFile returns a FetchFileResult", async () => {
    const resolvedBytes = pngBytes(1, 1);
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        const result: FetchFileResult = {
          bytes: resolvedBytes,
          mediaType: "image/png",
        };
        return result;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_refine" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/image"),
        filename: "image",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    const filePart = staged[0] as FilePart;
    // Resolver's mediaType wins over the ingestion-time guess.
    expect(filePart.mediaType).toBe("image/png");
  });

  it("preserves FilePart.mediaType when fetchFile returns a bare Buffer", async () => {
    const resolvedBytes = Buffer.from("CSV", "utf8");
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        return resolvedBytes;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_preserve" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/report.csv"),
        filename: "report.csv",
        mediaType: "text/csv",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    const filePart = staged[0] as FilePart;
    expect(filePart.mediaType).toBe("text/csv");
  });

  it("downloads a link no channel resolver claims, so the provider never fetches it", async () => {
    vi.mocked(requestPublicUrl).mockResolvedValueOnce(
      new Response(pngBytes(1, 1), { headers: { "content-type": "image/png" } }),
    );
    const adapter: ChannelAdapter<any> = { kind: "custom-channel", state: {} };
    const sandbox = mockSandbox({ id: "sbx_public_link" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/a.bin"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    expect(vi.mocked(requestPublicUrl)).toHaveBeenCalledWith(
      "https://example.com/a.bin",
      expect.objectContaining({ maxResponseSize: 25 * 1024 * 1024 }),
    );
    const filePart = staged[0] as FilePart;
    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    expect(filePart.mediaType).toBe("image/png");
  });

  it("turns a link eve can't download into a note", async () => {
    const sandbox = mockSandbox({ id: "sbx_bad_link" });
    const runtime = await createTestRuntime();
    vi.mocked(requestPublicUrl)
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }),
      )
      .mockRejectedValueOnce(new Error("URL must not target localhost"));
    const link = (data: string, filename: string): FilePart => ({
      data,
      filename,
      mediaType: "application/pdf",
      type: "file",
    });

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        link("http://example.com/plain.pdf", "plain.pdf"),
        link("https://example.com/gone.pdf", "gone.pdf"),
        link("https://docs.example.com/d/1", "doc.pdf"),
        link("https://127.0.0.1/internal.pdf", "internal.pdf"),
      ]),
    );

    expect(staged).toEqual([
      {
        text: "Attachment plain.pdf could not be retrieved: eve downloads only public https:// links.",
        type: "text",
      },
      {
        text: "Attachment gone.pdf could not be retrieved: The link returned HTTP 404.",
        type: "text",
      },
      {
        text: "Attachment doc.pdf could not be retrieved: The link returned a web page instead of a file.",
        type: "text",
      },
      {
        text: "Attachment internal.pdf could not be retrieved: The link could not be downloaded.",
        type: "text",
      },
    ]);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("downloads at most 10 links per message, one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(requestPublicUrl).mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response("bytes", { headers: { "content-type": "text/plain" } });
    });
    const sandbox = mockSandbox({ id: "sbx_download_budget" });
    const runtime = await createTestRuntime();
    const content: UserContent = Array.from({ length: 12 }, (_, index) => ({
      data: `https://example.com/${index}.txt`,
      filename: `${index}.txt`,
      mediaType: "text/plain",
      type: "file" as const,
    }));

    const staged = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;
    vi.mocked(requestPublicUrl).mockReset();

    expect(staged.filter((part) => part.type === "file")).toHaveLength(10);
    expect(staged.slice(10)).toEqual([
      {
        text: "Attachment 10.txt could not be retrieved: eve downloads at most 10 links per message.",
        type: "text",
      },
      {
        text: "Attachment 11.txt could not be retrieved: eve downloads at most 10 links per message.",
        type: "text",
      },
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("holds every staged file to the channel's upload policy, on its bytes and verified type", async () => {
    vi.mocked(requestPublicUrl).mockResolvedValueOnce(
      new Response("a much larger file", { headers: { "content-type": "text/plain" } }),
    );
    const adapter: ChannelAdapter<any> = {
      kind: "custom-channel",
      state: {},
      uploadPolicy: { allowedMediaTypes: ["application/pdf", "text/*"], maxBytes: 64 },
    };
    const sandbox = mockSandbox({ id: "sbx_policy" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: "https://example.com/notes.txt",
        filename: "notes.txt",
        mediaType: "text/plain",
        type: "file",
      },
      // Declared as an allowed PDF, but the bytes are a PNG.
      { data: pngBytes(1, 1), filename: "scan.pdf", mediaType: "application/pdf", type: "file" },
      { data: Buffer.alloc(65, 0x41), filename: "big.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(vi.mocked(requestPublicUrl)).toHaveBeenCalledWith(
      "https://example.com/notes.txt",
      expect.objectContaining({ maxResponseSize: 64 }),
    );
    expect((staged as Exclude<UserContent, string>).slice(1)).toEqual([
      {
        text: "Attachment scan.pdf was not accepted: this channel doesn't accept image/png files.",
        type: "text",
      },
      {
        text: "Attachment big.txt was not accepted: it is 65 bytes, over this channel's 64-byte upload limit.",
        type: "text",
      },
    ]);
    expect(sandbox.writes).toHaveLength(1);
  });

  it("leaves a provider file reference for the provider to resolve", async () => {
    const sandbox = mockSandbox({ id: "sbx_reference" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      { data: { openai: "file-abc" }, mediaType: "application/pdf", type: "file" },
    ];

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toEqual(content);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("degrades plain resolver errors to a channel-neutral safe note", async () => {
    const logs = captureLogRecords();
    const upstream = new Error("boom https://secret.example/file?token=private");
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        throw upstream;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_threw" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/a.bin"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;

    expect(staged).toEqual([
      {
        text: 'Attachment a.bin could not be retrieved: Attachment retrieval failed in the "custom-channel" channel.',
        type: "text",
      },
    ]);
    expect(staged[0]).not.toHaveProperty("text", expect.stringContaining("secret.example"));
    expect(sandbox.writes).toHaveLength(0);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "attachment resolver failed — degrading to text part",
      }),
    );
  });

  it("exposes a channel-authored safe resolver error to the model", async () => {
    const logs = captureLogRecords();
    const resolverError = new EveAttachmentError({
      adapterKind: "custom-channel",
      kind: "resolver-threw",
      message: "Slack file fetch returned HTTP 403.",
    });
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        throw resolverError;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_propagate" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/a.bin"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;

    expect(staged).toEqual([
      {
        text: "Attachment a.bin could not be retrieved: Slack file fetch returned HTTP 403.",
        type: "text",
      },
    ]);
    expect(sandbox.writes).toHaveLength(0);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "attachment resolver failed — degrading to text part",
      }),
    );
  });

  it("stages sibling attachments when one resolver call fails", async () => {
    const logs = captureLogRecords();
    const adapter: ChannelAdapter<any> = {
      async fetchFile(url) {
        if (url.endsWith("missing.bin")) {
          throw new EveAttachmentError({
            adapterKind: "custom-channel",
            kind: "resolver-threw",
            message: "Attachment service returned HTTP 503.",
          });
        }
        return { bytes: Buffer.from("available") };
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_partial_failure" });
    const runtime = await createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/missing.bin"),
        filename: "missing.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
      {
        data: new URL("https://example.com/available.bin"),
        filename: "available.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;

    expect(staged[0]).toEqual({
      text: "Attachment missing.bin could not be retrieved: Attachment service returned HTTP 503.",
      type: "text",
    });
    expect((staged[1] as FilePart).filename).toMatch(/\/available\.bin$/);
    expect(sandbox.writes).toHaveLength(1);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "attachment resolver failed — degrading to text part",
      }),
    );
  });

  it("works alongside non-file parts in the same user message", async () => {
    const sandbox = mockSandbox({ id: "sbx_mixed" });
    const runtime = await createTestRuntime();
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const fileBytes = Buffer.from("text", "utf8");

    const content: UserContent = [
      { type: "text", text: "what do you see?" },
      { type: "image", mediaType: "image/png", image: imageBytes },
      { data: fileBytes, filename: "notes.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as Exclude<UserContent, string>;

    expect(staged).toHaveLength(3);
    expect(staged[0]).toEqual({ type: "text", text: "what do you see?" });
    expect(staged[1]?.type).toBe("image");
    const filePart = staged[2] as FilePart;
    expect(filePart.filename).toMatch(/\/attachments\/[0-9a-f]{16}\/notes\.txt$/);
    expect(sandbox.writes).toHaveLength(1);
  });
});

describe("hydrateSandboxAttachments (integration)", () => {
  // A small PNG and PDF under the inline caps; the byte-equality assertions
  // catch any corruption on the sandbox round trip.
  const smallImageBytes = pngBytes(32, 32, 1024);
  const smallPdfBytes = pdfBytes(1024);

  it("hydrates small images inline as bytes — provider consumes them multimodally", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_image" });
    const runtime = await createTestRuntime();

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { type: "text", text: "describe the image" },
        { data: smallImageBytes, filename: "logo.png", mediaType: "image/png", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const messages = [{ content: stagedContent, role: "user" as const }];

    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    // Original ref-only messages are preserved — the staged FilePart
    // still carries an eve-sandbox: URL, not bytes, so it remains
    // safe to persist into session.history.
    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file");
    expect(refPart).toBeDefined();
    expect(isSandboxRefUrl(refPart?.data)).toBe(true);

    // The hydrated copy carries the bytes — for one-shot handoff to
    // the model.
    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    const hydratedFilePart = hydratedContent.find(
      (p) => (p as FilePart).type === "file",
    ) as FilePart;
    expect(Buffer.isBuffer(hydratedFilePart.data)).toBe(true);
    expect((hydratedFilePart.data as Buffer).equals(smallImageBytes)).toBe(true);
    expect(hydratedFilePart.mediaType).toBe("image/png");
    expect(hydratedFilePart.filename).toMatch(
      /^\/workspace\/\.eve\/attachments\/[0-9a-f]{16}\/logo\.png$/,
    );
    // A label naming the sandbox path precedes the bytes.
    expect(hydratedContent).toEqual([
      { type: "text", text: "describe the image" },
      { text: `Attached file ${hydratedFilePart.filename} (image/png)`, type: "text" },
      hydratedFilePart,
    ]);
  });

  it("hydrates small PDFs inline as bytes — provider handles them natively", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_pdf" });
    const runtime = await createTestRuntime();

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { data: smallPdfBytes, filename: "doc.pdf", mediaType: "application/pdf", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const messages = [{ content: stagedContent, role: "user" as const }];

    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    const hydratedFilePart = hydratedContent.find(
      (p) => (p as FilePart).type === "file",
    ) as FilePart;
    expect(Buffer.isBuffer(hydratedFilePart.data)).toBe(true);
    expect((hydratedFilePart.data as Buffer).equals(smallPdfBytes)).toBe(true);
    expect(hydratedFilePart.mediaType).toBe("application/pdf");
  });

  it("substitutes non-inlinable FileParts with a text reference pointing at the sandbox path", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_text_ref" });
    const runtime = await createTestRuntime();
    const csvBytes = Buffer.from("id,name\n1,alpha\n", "utf8");

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { type: "text", text: "summarize" },
        { data: csvBytes, filename: "report.csv", mediaType: "text/csv", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file") as FilePart;
    expect(isSandboxRefUrl(refPart.data)).toBe(true);
    const stagedPath = refPart.filename as string;

    const messages = [{ content: stagedContent, role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    // The hydrated content swaps the FilePart for a TextPart that
    // names the sandbox path — the agent's filesystem tools
    // (`read_file`, `bash`, …) take it from here.
    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    expect(hydratedContent).toHaveLength(2);
    expect(hydratedContent[0]).toEqual({ type: "text", text: "summarize" });
    expect(hydratedContent[1]).toEqual({
      text: `Attached file ${stagedPath} (text/csv)`,
      type: "text",
    });
    // No file part survived hydration for the non-inlinable CSV.
    const fileParts = hydratedContent.filter((p) => (p as FilePart).type === "file");
    expect(fileParts).toHaveLength(0);
  });

  it("treats oversized images (>3 MiB) as non-inlinable — renders a text reference instead of bytes", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_big_image" });
    const runtime = await createTestRuntime();
    // One byte over the 3 MiB cap so the ref size fails the inline
    // check without allocating two massive buffers in the test.
    const oversizedImage = pngBytes(32, 32, 3 * 1024 * 1024 + 1);

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { data: oversizedImage, filename: "huge.png", mediaType: "image/png", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file") as FilePart;
    const stagedPath = refPart.filename as string;

    const messages = [{ content: stagedContent, role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    expect(hydratedContent[0]).toEqual({
      text: `Attached file ${stagedPath} (image/png)`,
      type: "text",
    });
  });

  it("treats oversized PDFs (>20 MiB) as non-inlinable — renders a text reference instead of bytes", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_big_pdf" });
    const runtime = await createTestRuntime();
    const oversizedPdf = pdfBytes(20 * 1024 * 1024 + 1);

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        {
          data: oversizedPdf,
          filename: "huge.pdf",
          mediaType: "application/pdf",
          type: "file",
        },
      ] as UserContent),
    )) as UserContent;

    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file") as FilePart;
    const stagedPath = refPart.filename as string;

    const messages = [{ content: stagedContent, role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    expect(hydratedContent[0]).toEqual({
      text: `Attached file ${stagedPath} (application/pdf)`,
      type: "text",
    });
  });

  it("treats unknown binary media types as non-inlinable — renders a text reference", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_binary" });
    const runtime = await createTestRuntime();
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        {
          data: binary,
          filename: "payload.bin",
          mediaType: "application/octet-stream",
          type: "file",
        },
      ] as UserContent),
    )) as UserContent;

    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file") as FilePart;
    const stagedPath = refPart.filename as string;

    const messages = [{ content: stagedContent, role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    expect(hydratedContent[0]).toEqual({
      text: `Attached file ${stagedPath} (application/octet-stream)`,
      type: "text",
    });
  });

  it("inlines only images whose bytes prove a format every provider reads", async () => {
    const sandbox = mockSandbox({ id: "sbx_verified_media" });
    const runtime = await createTestRuntime();

    const staged = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        {
          data: Buffer.from("not a png"),
          filename: "fake.png",
          mediaType: "image/png",
          type: "file",
        },
        {
          data: Buffer.from("ftypheic"),
          filename: "photo.heic",
          mediaType: "image/heic",
          type: "file",
        },
        { data: pngBytes(8001, 10), filename: "wide.png", mediaType: "image/png", type: "file" },
        { data: pngBytes(4, 4), filename: "real.jpg", mediaType: "image/jpeg", type: "file" },
      ] as UserContent),
    )) as FilePart[];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments([{ content: staged, role: "user" }]),
    );

    expect(staged.map((part) => part.mediaType)).toEqual([
      "application/octet-stream",
      "image/heic",
      "image/png",
      "image/png",
    ]);
    expect(hydrated[0]?.content).toEqual([
      { text: `Attached file ${staged[0]!.filename} (application/octet-stream)`, type: "text" },
      { text: `Attached file ${staged[1]!.filename} (image/heic)`, type: "text" },
      { text: `Attached file ${staged[2]!.filename} (image/png)`, type: "text" },
      { text: `Attached file ${staged[3]!.filename} (image/png)`, type: "text" },
      expect.objectContaining({ mediaType: "image/png", type: "file" }),
    ]);
  });

  it("applies the same rule to files a tool returns", async () => {
    const sandbox = mockSandbox({ id: "sbx_tool_gate" });
    const runtime = await createTestRuntime();
    const file = (data: Buffer, filename: string, mediaType = "image/png") => ({
      data: { data: data.toString("base64"), type: "data" as const },
      filename,
      mediaType,
      type: "file" as const,
    });
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                file(pngBytes(9000, 9000), "huge.png"),
                file(pngBytes(8, 8), "shot.png"),
                file(pngBytes(8, 8), "mislabeled.jpg", "image/jpeg"),
              ],
            },
            toolCallId: "shot-1",
            toolName: "screenshot",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(await stageToolResultMedia(messages)),
    );

    const [result] = hydrated[0]!.content as ToolResultPart[];
    expect(result!.output).toEqual({
      type: "content",
      value: [
        {
          text: expect.stringMatching(/^Attached file .*\/huge\.png \(image\/png\)$/),
          type: "text",
        },
        {
          text: expect.stringMatching(/^Attached file .*\/shot\.png \(image\/png\)$/),
          type: "text",
        },
        expect.objectContaining({ filename: "shot.png", type: "file" }),
        {
          text: expect.stringMatching(/^Attached file .*\/mislabeled\.jpg \(image\/png\)$/),
          type: "text",
        },
        // The bytes go to the provider under the type they prove.
        expect.objectContaining({ filename: "mislabeled.jpg", mediaType: "image/png" }),
      ],
    });
  });

  it("renders a link or eve-url marker left in history by an older release as a note", async () => {
    const runtime = await createTestRuntime();
    const messages: ModelMessage[] = [
      {
        content: [
          { text: "what is in these?", type: "text" },
          {
            data: new URL("https://docs.example.com/d/1"),
            filename: "sheet.pdf",
            mediaType: "application/pdf",
            type: "file",
          },
          {
            data: "eve-url:telegram-file:photo",
            filename: "photo.jpg",
            mediaType: "image/jpeg",
            type: "file",
          },
        ],
        role: "user",
      },
    ];

    const hydrated = await runtime.runAsSession(undefined, async () =>
      hydrateSandboxAttachments(messages),
    );

    expect(hydrated[0]?.content).toEqual([
      { text: "what is in these?", type: "text" },
      { text: "Attachment sheet.pdf could not be retrieved.", type: "text" },
      { text: "Attachment photo.jpg could not be retrieved.", type: "text" },
    ]);
  });

  it("returns the input array unchanged (no allocation) when no messages contain sandbox refs", async () => {
    const sandbox = mockSandbox({ id: "sbx_noop" });
    const runtime = await createTestRuntime();

    const messages = [{ content: "plain text", role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    expect(hydrated).toBe(messages);
  });

  it("is idempotent on inline Buffer FileParts", async () => {
    const sandbox = mockSandbox({ id: "sbx_idempotent" });
    const runtime = await createTestRuntime();
    const bytes = Buffer.from("hi", "utf8");
    const messages = [
      {
        content: [
          { data: bytes, filename: "hi.txt", mediaType: "text/plain", type: "file" },
        ] as UserContent,
        role: "user" as const,
      },
    ];

    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    // No sandbox refs → pass-through.
    expect(hydrated).toBe(messages);
  });

  it("degrades to a text reference when an inlinable sandbox ref points at a missing file", async () => {
    const logs = captureLogRecords();
    // Resuming a durable session whose staging sandbox was torn down
    // leaves historical attachment refs pointing at bytes that are gone.
    // Hydration must not fail the whole turn over it — it degrades to a
    // text part so the run survives (#276).
    const sandbox = mockSandbox({ id: "sbx_missing" });
    const runtime = await createTestRuntime();

    // Ref pointing at a path that was never written. Use an
    // inlinable media type so the byte-read path fires —
    // non-inlinable refs never touch the sandbox.
    const danglingRef = new URL(
      "eve-sandbox:?path=%2Fworkspace%2Fattachments%2Fdeadbeefdeadbeef%2Fghost.png&size=5&type=image%2Fpng",
    );
    const messages = [
      {
        content: [
          { type: "text", text: "what's in the image?" },
          {
            data: danglingRef,
            filename: "/workspace/attachments/deadbeefdeadbeef/ghost.png",
            mediaType: "image/png",
            type: "file",
          },
        ] as UserContent,
        role: "user" as const,
      },
    ];

    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    // The leading text survives and the dangling file ref is replaced by
    // an unavailability notice — no file part reaches the model.
    expect(hydratedContent[0]).toEqual({ type: "text", text: "what's in the image?" });
    expect(hydratedContent[1]).toEqual({
      text: "FileNotFound: Current snapshot may be newer and does not contain /workspace/attachments/deadbeefdeadbeef/ghost.png.",
      type: "text",
    });
    const fileParts = hydratedContent.filter((p) => (p as FilePart).type === "file");
    expect(fileParts).toHaveLength(0);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "sandbox-ref attachment bytes missing on hydration — degrading to text reference",
      }),
    );
  });

  it("survives a resume after the staging sandbox was torn down (#276)", async () => {
    const logs = captureLogRecords();
    // Stage an image into one sandbox, then hydrate the resulting
    // ref-only message against a fresh sandbox — the same shape as
    // resuming a durable session whose ephemeral sandbox is gone. The
    // bytes are unreachable, but the turn must not fail.
    const stagingSandbox = mockSandbox({ id: "sbx_resume_stage" });
    const runtime = await createTestRuntime();

    const stagedContent = (await runtime.runAsSession({ sandbox: stagingSandbox }, async () =>
      stageAttachmentsToSandbox([
        { type: "text", text: "describe the image" },
        { data: smallImageBytes, filename: "logo.png", mediaType: "image/png", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const refPart = (stagedContent as FilePart[]).find((p) => p.type === "file") as FilePart;
    const stagedPath = refPart.filename as string;

    const messages = [{ content: stagedContent, role: "user" as const }];
    const freshSandbox = mockSandbox({ id: "sbx_resume_fresh" });
    const hydrated = await runtime.runAsSession({ sandbox: freshSandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    const hydratedContent = hydrated[0]?.content as Exclude<UserContent, string>;
    expect(hydratedContent[0]).toEqual({ type: "text", text: "describe the image" });
    expect(hydratedContent[1]).toEqual({
      text: `FileNotFound: Current snapshot may be newer and does not contain ${stagedPath}.`,
      type: "text",
    });
    expect(hydratedContent.filter((p) => (p as FilePart).type === "file")).toHaveLength(0);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "sandbox-ref attachment bytes missing on hydration — degrading to text reference",
      }),
    );
  });

  it("does not inline a staged attachment that sandbox code overwrote (#4284)", async () => {
    const sandbox = mockSandbox({ id: "sbx_overwritten" });
    const runtime = await createTestRuntime();

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { data: smallImageBytes, filename: "logo.png", mediaType: "image/png", type: "file" },
      ] as UserContent),
    )) as UserContent;
    const stagedPath = (stagedContent[0] as FilePart).filename as string;

    // Same size, different bytes: only the content address can tell them apart.
    await sandbox.session.writeBinaryFile({
      content: Buffer.alloc(smallImageBytes.byteLength, 0x41),
      path: stagedPath,
    });

    const messages = [{ content: stagedContent, role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    expect(hydrated[0]?.content).toEqual([
      {
        text: `FileNotFound: Current snapshot may be newer and does not contain ${stagedPath}.`,
        type: "text",
      },
    ]);
  });

  it("does not touch the sandbox when every ref is non-inlinable — text references carry all the info", async () => {
    // Regression guard: the non-inlinable path must render the text
    // reference entirely from ref metadata (path, mediaType, size)
    // without reading bytes. Otherwise large non-inlinable files
    // would still cost a full sandbox read per turn just to be
    // thrown away.
    const sandbox = mockSandbox({ id: "sbx_no_read" });
    const runtime = await createTestRuntime();
    const csvBytes = Buffer.from("id,name\n1,alpha\n", "utf8");

    const stagedContent = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox([
        { data: csvBytes, filename: "r.csv", mediaType: "text/csv", type: "file" },
      ] as UserContent),
    )) as UserContent;

    const messages = [{ content: stagedContent, role: "user" as const }];

    const readSpy = vi.spyOn(sandbox.session, "readBinaryFile");
    try {
      await runtime.runAsSession({ sandbox }, async () => hydrateSandboxAttachments(messages));
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
});

function pdfBytes(paddingBytes: number): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(paddingBytes, 0x25)]);
}
