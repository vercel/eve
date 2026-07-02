import type { FilePart, UserContent } from "ai";
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
} from "#harness/attachment-staging.js";

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
  it("writes FilePart bytes into the active sandbox and rewrites data to an eve-sandbox: ref", async () => {
    const sandbox = mockSandbox({ id: "sbx_integration" });
    const runtime = createTestRuntime();
    const csvBytes = Buffer.from("id,name\n1,alpha\n", "utf8");

    const content: UserContent = [
      { type: "text", text: "summarize this csv" },
      { data: csvBytes, filename: "report.csv", mediaType: "text/csv", type: "file" },
    ];

    const staged = (await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    expect(Array.isArray(staged)).toBe(true);
    expect(staged).toHaveLength(2);
    expect(staged[0]).toEqual({ type: "text", text: "summarize this csv" });

    const filePart = staged[1] as FilePart;
    expect(filePart.mediaType).toBe("text/csv");
    // Staged `data` is an eve-sandbox: ref (NOT raw bytes). The
    // refactor's key invariant: bytes never travel on the message,
    // only the ref does.
    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    const ref = decodeSandboxRef(filePart.data as URL);
    expect(ref.mediaType).toBe("text/csv");
    expect(ref.size).toBe(csvBytes.byteLength);
    expect(ref.path).toMatch(/^\/workspace\/attachments\/[0-9a-f]{16}\/report\.csv$/);
    expect(filePart.filename).toBe(ref.path);

    expect(sandbox.writes).toHaveLength(1);
    const write = sandbox.writes[0];
    expect(write?.path).toMatch(new RegExp(`^${ATTACHMENTS_ROOT}/[0-9a-f]{16}/report\\.csv$`));
    const writtenBytes = write?.content as Buffer;
    expect(Buffer.isBuffer(writtenBytes)).toBe(true);
    expect(writtenBytes.equals(csvBytes)).toBe(true);
  });

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
    const runtime = createTestRuntime({ tools: [readTool] });
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

  it("passes text-only messages through without touching the sandbox", async () => {
    const sandbox = mockSandbox({ id: "sbx_text" });
    const runtime = createTestRuntime();

    const result = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox("hello"),
    );

    expect(result).toBe("hello");
    expect(sandbox.writes).toHaveLength(0);
  });

  it("passes UserContent arrays with no FileParts through untouched", async () => {
    const sandbox = mockSandbox({ id: "sbx_no_files" });
    const runtime = createTestRuntime();
    const content: UserContent = [{ type: "text", text: "just text" }];

    const staged = await runtime.runAsSession({ sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toBe(content);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("returns the message unchanged when no SandboxKey is bound on the context", async () => {
    const runtime = createTestRuntime();
    const payload = Buffer.from("bytes", "utf8");
    const content: UserContent = [
      { data: payload, filename: "orphan.txt", mediaType: "text/plain", type: "file" },
    ];

    // `runAsSession` without a sandbox argument leaves SandboxKey unbound.
    const staged = await runtime.runAsSession(undefined, async () =>
      stageAttachmentsToSandbox(content),
    );

    expect(staged).toBe(content);
  });

  it("dedupes repeated uploads of the same payload within one session", async () => {
    const sandbox = mockSandbox({ id: "sbx_dedupe" });
    const runtime = createTestRuntime();
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
      async fetchFile(url) {
        fetchFileCalls += 1;
        // fetchFile receives the URL string from the FilePart.
        expect(url).toBe("https://example.com/file");
        return resolvedBytes;
      },
      kind: "custom-channel",
      state: { opener: "alice" },
    };

    const sandbox = mockSandbox({ id: "sbx_ref" });
    const runtime = createTestRuntime();
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
      new RegExp(`^${ATTACHMENTS_ROOT}/[0-9a-f]{16}/report\\.csv$`),
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

  it("refines FilePart.mediaType when fetchFile returns a FetchFileResult", async () => {
    const resolvedBytes = Buffer.from("PNGDATA", "utf8");
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
    const runtime = createTestRuntime();
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
    const runtime = createTestRuntime();
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

  it("passes URL FileParts through unchanged when the active adapter has no fetchFile function", async () => {
    const adapter: ChannelAdapter<any> = { kind: "custom-channel", state: {} };
    const fileUrl = new URL("https://example.com/a.bin");
    const sandbox = mockSandbox({ id: "sbx_no_resolver" });
    const runtime = createTestRuntime();
    const content: UserContent = [
      { data: fileUrl, filename: "a.bin", mediaType: "application/octet-stream", type: "file" },
    ];

    const staged = (await runtime.runAsSession({ channel: adapter, sandbox }, async () =>
      stageAttachmentsToSandbox(content),
    )) as UserContent;

    // Without fetchFile, URL FileParts pass through for the model
    // provider to handle directly.
    const filePart = staged[0] as FilePart;
    expect(filePart.data).toBeInstanceOf(URL);
    expect((filePart.data as URL).href).toBe("https://example.com/a.bin");
    expect(sandbox.writes).toHaveLength(0);
  });

  it("wraps uncategorized fetchFile throws as resolver-threw", async () => {
    const upstream = new Error("boom");
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        throw upstream;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_threw" });
    const runtime = createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/a.bin"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    await expect(
      runtime.runAsSession({ channel: adapter, sandbox }, async () =>
        stageAttachmentsToSandbox(content),
      ),
    ).rejects.toMatchObject({ cause: upstream, kind: "resolver-threw" });
  });

  it("propagates EveAttachmentError from fetchFile unchanged", async () => {
    const resolverError = new EveAttachmentError({
      adapterKind: "custom-channel",
      kind: "resolver-threw",
      message: "test resolver error",
    });
    const adapter: ChannelAdapter<any> = {
      async fetchFile() {
        throw resolverError;
      },
      kind: "custom-channel",
      state: {},
    };
    const sandbox = mockSandbox({ id: "sbx_propagate" });
    const runtime = createTestRuntime();
    const content: UserContent = [
      {
        data: new URL("https://example.com/a.bin"),
        filename: "a.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    await expect(
      runtime.runAsSession({ channel: adapter, sandbox }, async () =>
        stageAttachmentsToSandbox(content),
      ),
    ).rejects.toBe(resolverError);
  });

  it("works alongside non-file parts in the same user message", async () => {
    const sandbox = mockSandbox({ id: "sbx_mixed" });
    const runtime = createTestRuntime();
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
  // 1 KiB of PNG-like bytes. Small enough to fall under the image
  // inline-cap, arbitrary enough that the byte-equality assertion
  // catches any corruption on the sandbox round trip.
  const smallImageBytes = Buffer.alloc(1024, 0x89);
  // 1 KiB of PDF-like bytes. Small enough to fall under the PDF
  // inline-cap.
  const smallPdfBytes = Buffer.alloc(1024, 0x25);

  it("hydrates small images inline as bytes — provider consumes them multimodally", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_image" });
    const runtime = createTestRuntime();

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
      /^\/workspace\/attachments\/[0-9a-f]{16}\/logo\.png$/,
    );
  });

  it("hydrates small PDFs inline as bytes — provider handles them natively", async () => {
    const sandbox = mockSandbox({ id: "sbx_hydrate_pdf" });
    const runtime = createTestRuntime();

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
    const runtime = createTestRuntime();
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
    const runtime = createTestRuntime();
    // One byte over the 3 MiB cap so the ref size fails the inline
    // check without allocating two massive buffers in the test.
    const oversizedImage = Buffer.alloc(3 * 1024 * 1024 + 1, 0x89);

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
    const runtime = createTestRuntime();
    const oversizedPdf = Buffer.alloc(20 * 1024 * 1024 + 1, 0x25);

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
    const runtime = createTestRuntime();
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

  it("returns the input array unchanged (no allocation) when no messages contain sandbox refs", async () => {
    const sandbox = mockSandbox({ id: "sbx_noop" });
    const runtime = createTestRuntime();

    const messages = [{ content: "plain text", role: "user" as const }];
    const hydrated = await runtime.runAsSession({ sandbox }, async () =>
      hydrateSandboxAttachments(messages),
    );

    expect(hydrated).toBe(messages);
  });

  it("is idempotent on inline Buffer FileParts", async () => {
    const sandbox = mockSandbox({ id: "sbx_idempotent" });
    const runtime = createTestRuntime();
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
    // Resuming a durable session whose staging sandbox was torn down
    // leaves historical attachment refs pointing at bytes that are gone.
    // Hydration must not fail the whole turn over it — it degrades to a
    // text part so the run survives (#276).
    const sandbox = mockSandbox({ id: "sbx_missing" });
    const runtime = createTestRuntime();

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
  });

  it("survives a resume after the staging sandbox was torn down (#276)", async () => {
    // Stage an image into one sandbox, then hydrate the resulting
    // ref-only message against a fresh sandbox — the same shape as
    // resuming a durable session whose ephemeral sandbox is gone. The
    // bytes are unreachable, but the turn must not fail.
    const stagingSandbox = mockSandbox({ id: "sbx_resume_stage" });
    const runtime = createTestRuntime();

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
  });

  it("does not touch the sandbox when every ref is non-inlinable — text references carry all the info", async () => {
    // Regression guard: the non-inlinable path must render the text
    // reference entirely from ref metadata (path, mediaType, size)
    // without reading bytes. Otherwise large non-inlinable files
    // would still cost a full sandbox read per turn just to be
    // thrown away.
    const sandbox = mockSandbox({ id: "sbx_no_read" });
    const runtime = createTestRuntime();
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
