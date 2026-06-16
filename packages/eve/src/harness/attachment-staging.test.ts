import type { FilePart, UserContent } from "ai";
import { describe, expect, it } from "vitest";

import type { ChannelAdapterContext } from "#channel/adapter.js";
import { ContextContainer } from "#context/container.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { ATTACHMENTS_ROOT, stageAttachmentsForAdapter } from "#harness/attachment-staging.js";

const UTF8 = new TextEncoder();
const ATTACHMENTS_PATH_PATTERN = /^\/workspace\/attachments\/[0-9a-f]{16}\//;

/**
 * Minimal {@link ChannelAdapterContext} for tests that never encounter
 * an attachment ref. Backed by an empty {@link ContextContainer} so
 * any accidental ref will fail the `ChannelKey` lookup inside staging
 * and surface as a clear `missing-adapter` error instead of silently
 * succeeding.
 */
const STUB_ADAPTER_CTX: ChannelAdapterContext = {
  ctx: new ContextContainer(),
  state: {},
  session: {
    id: "",
    continuationToken: "",
    auth: { current: null, initiator: null },
    setContinuationToken: () => {},
  },
};

function findWrite(
  sandbox: ReturnType<typeof mockSandbox>,
  filenameSuffix: string,
): { path: string; content: string | Uint8Array } | undefined {
  return sandbox.writes.find((write) => write.path.endsWith(filenameSuffix));
}

describe("stageAttachmentsForAdapter", () => {
  it("passes plain-string messages through unchanged and never touches the sandbox", async () => {
    const sandbox = mockSandbox();
    const result = await stageAttachmentsForAdapter(
      "summarize this",
      sandbox.session,
      STUB_ADAPTER_CTX,
    );

    expect(result).toBe("summarize this");
    expect(sandbox.writes).toHaveLength(0);
    expect(sandbox.commandLog).toEqual([]);
  });

  it("stages a FilePart into the sandbox, rewrites data to an eve-sandbox: ref, and preserves mediaType", async () => {
    const sandbox = mockSandbox();
    const data = Buffer.from("id,name\n1,alpha\n", "utf8");
    const content: UserContent = [
      { type: "text", text: "summarize this csv" },
      { data, filename: "quarterly.csv", mediaType: "text/csv", type: "file" },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;

    expect(staged).toHaveLength(2);
    expect(staged[0]).toEqual({ type: "text", text: "summarize this csv" });
    const filePart = staged[1] as FilePart;
    expect(filePart.type).toBe("file");
    // mediaType is preserved in parallel with the ref so AI SDK
    // consumers still see the expected shape.
    expect(filePart.mediaType).toBe("text/csv");
    // data is an eve-sandbox: ref URL (NOT raw bytes) — the key
    // invariant the refactor establishes.
    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    const ref = decodeSandboxRef(filePart.data as URL);
    expect(ref.mediaType).toBe("text/csv");
    expect(ref.size).toBe(data.byteLength);
    expect(ref.path).toMatch(/^\/workspace\/attachments\/[0-9a-f]{16}\/quarterly\.csv$/);
    expect(filePart.filename).toBe(ref.path);

    expect(sandbox.writes).toHaveLength(1);
    const write = sandbox.writes[0];
    expect(write?.path).toMatch(new RegExp(`^${ATTACHMENTS_ROOT}/[0-9a-f]{16}/quarterly\\.csv$`));
    expect(write?.content).toEqual(data);
  });

  it("sanitizes caller-supplied filenames — path traversal is stripped to basename", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      {
        data: Buffer.from("root:x:0:0", "utf8"),
        filename: "../../etc/passwd",
        mediaType: "text/plain",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename?.endsWith("/passwd")).toBe(true);
    expect(filePart.filename).not.toContain("..");
    expect(sandbox.writes[0]?.path).toMatch(/\/attachments\/[0-9a-f]{16}\/passwd$/);
    expect(sandbox.writes[0]?.path).not.toContain("..");
  });

  it("replaces unsafe characters in the filename with underscores", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      {
        data: Buffer.from("hi", "utf8"),
        filename: "weird name!.txt",
        mediaType: "text/plain",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename?.endsWith("/weird_name_.txt")).toBe(true);
  });

  it("falls back to file-<sha> when no filename is supplied", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      {
        data: Buffer.from("raw", "utf8"),
        mediaType: "application/octet-stream",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename).toMatch(/\/attachments\/[0-9a-f]{16}\/file-[0-9a-f]{16}$/);
  });

  it("decodes data-URL file payloads before writing and rewrites data to a sandbox ref", async () => {
    const sandbox = mockSandbox();
    const payload = "id,name\n1,alpha";
    const dataUrl = `data:text/csv;base64,${Buffer.from(payload).toString("base64")}`;
    const content: UserContent = [
      { data: dataUrl, filename: "report.csv", mediaType: "text/csv", type: "file" },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename?.endsWith("/report.csv")).toBe(true);
    // Post-staging `data` is the sandbox ref — not the bytes — so
    // `session.history` never carries the raw payload across step
    // boundaries. The bytes are written into the sandbox and
    // rehydrated by the tool loop right before the model call.
    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    const ref = decodeSandboxRef(filePart.data as URL);
    expect(ref.size).toBe(Buffer.byteLength(payload, "utf8"));
    expect(ref.mediaType).toBe("text/csv");

    const write = findWrite(sandbox, "report.csv");
    expect(write).toBeDefined();
    const written = write?.content as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(written.toString("utf8")).toBe(payload);
  });

  it("decodes bare base64 strings the same way AI SDK DataContent does and rewrites data to a sandbox ref", async () => {
    const sandbox = mockSandbox();
    const payload = "hello-from-base64";
    const base64 = Buffer.from(payload, "utf8").toString("base64");
    const content: UserContent = [
      { data: base64, filename: "plain.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    // Post-staging, `data` is the sandbox ref URL; the decoded bytes
    // live in the sandbox, not on the message.
    expect(isSandboxRefUrl(filePart.data)).toBe(true);

    const written = sandbox.writes[0]?.content as Buffer;
    expect(written.toString("utf8")).toBe(payload);
  });

  it("leaves remote URL parts unchanged — the provider fetches them at call time", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      {
        data: new URL("https://example.com/chart.png"),
        filename: "chart.png",
        mediaType: "image/png",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename).toBe("chart.png");
    expect(filePart.data).toBeInstanceOf(URL);
    expect((filePart.data as URL).protocol).toBe("https:");
    expect(sandbox.writes).toHaveLength(0);
  });

  it("passes already-staged eve-sandbox: ref parts through unchanged (idempotent)", async () => {
    const sandbox = mockSandbox();
    const existingRef = new URL(
      "eve-sandbox:?path=%2Fworkspace%2Fattachments%2Fdeadbeef01234567%2Ffoo.png&size=42&type=image%2Fpng",
    );
    const content: UserContent = [
      {
        data: existingRef,
        filename: "/workspace/attachments/deadbeef01234567/foo.png",
        mediaType: "image/png",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    // Same URL, no re-write, no re-fetch.
    expect(filePart.data).toBe(existingRef);
    expect(sandbox.writes).toHaveLength(0);
  });

  it("accepts ArrayBuffer and Uint8Array payloads transparently", async () => {
    const sandbox = mockSandbox();
    const arrayBufferBytes = UTF8.encode("array-buffer-payload").buffer;
    const uint8Bytes = UTF8.encode("uint8-payload");
    const content: UserContent = [
      {
        data: arrayBufferBytes,
        filename: "ab.bin",
        mediaType: "application/octet-stream",
        type: "file",
      },
      { data: uint8Bytes, filename: "u8.bin", mediaType: "application/octet-stream", type: "file" },
    ];

    await stageAttachmentsForAdapter(content, sandbox.session, STUB_ADAPTER_CTX);

    const ab = findWrite(sandbox, "ab.bin")?.content as Buffer;
    const u8 = findWrite(sandbox, "u8.bin")?.content as Buffer;
    expect(ab.toString("utf8")).toBe("array-buffer-payload");
    expect(u8.toString("utf8")).toBe("uint8-payload");
  });

  it("dedupes identical payloads under the same SHA directory", async () => {
    const sandbox = mockSandbox();
    const bytes = Buffer.from("shared", "utf8");
    const content: UserContent = [
      { data: bytes, filename: "a.txt", mediaType: "text/plain", type: "file" },
      { data: bytes, filename: "b.txt", mediaType: "text/plain", type: "file" },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const first = staged[0] as FilePart;
    const second = staged[1] as FilePart;

    const firstSha = /attachments\/([0-9a-f]{16})\//.exec(first.filename ?? "")?.[1];
    const secondSha = /attachments\/([0-9a-f]{16})\//.exec(second.filename ?? "")?.[1];

    expect(firstSha).toBeDefined();
    expect(firstSha).toBe(secondSha);
  });

  it("passes non-file parts through untouched", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      { type: "text", text: "hi" },
      { type: "image", mediaType: "image/png", image: new Uint8Array([1, 2, 3]) },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as Exclude<UserContent, string>;

    expect(staged[0]).toEqual({ type: "text", text: "hi" });
    expect(staged[1]?.type).toBe("image");
    expect(sandbox.writes).toHaveLength(0);
  });

  it("falls back to application/octet-stream in the ref when mediaType is absent on the FilePart", async () => {
    const sandbox = mockSandbox();
    const content: UserContent = [
      // mediaType omitted — the ref's `type` param still has to be
      // populated because decodeSandboxRef rejects empty strings.
      { data: Buffer.from("bytes", "utf8"), filename: "x.bin", type: "file" } as FilePart,
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(isSandboxRefUrl(filePart.data)).toBe(true);
    const ref = decodeSandboxRef(filePart.data as URL);
    expect(ref.mediaType).toBe("application/octet-stream");
    expect(filePart.mediaType).toBe("application/octet-stream");
  });

  it("resolves authored paths through the sandbox so backend-specific workspace roots are honored", async () => {
    // The runtime's real Vercel sandbox backend rewrites /workspace/...
    // to /vercel/sandbox/workspace/..., matching what read_file and bash
    // see. The mock sandbox does not itself rewrite (it anchors relative
    // paths under /workspace/), so this test pins the expected format
    // to make regressions in the staging path visible.
    const sandbox = mockSandbox();
    const content: UserContent = [
      {
        data: Buffer.from("resolve", "utf8"),
        filename: "resolve.txt",
        mediaType: "text/plain",
        type: "file",
      },
    ];

    const staged = (await stageAttachmentsForAdapter(
      content,
      sandbox.session,
      STUB_ADAPTER_CTX,
    )) as UserContent;
    const filePart = staged[0] as FilePart;

    expect(filePart.filename).toMatch(ATTACHMENTS_PATH_PATTERN);
  });
});
