import type { FilePart, TextPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  attachLinearInboundUploads,
  extractLinearUploadReferences,
} from "#public/channels/linear/inbound-uploads.js";

describe("extractLinearUploadReferences", () => {
  it("extracts trusted Linear markdown images and file links and ignores other hosts", () => {
    const markdown = [
      'First ![screenshot](https://uploads.linear.app/acme/one/image.png?signature=one "One").',
      "Second ![diagram](<https://uploads.linear.app/acme/two/diagram.jpg?signature=two>).",
      "Report [report.pdf](https://uploads.linear.app/acme/three/report.pdf).",
      "External ![chart](https://images.example.com/chart.png) [docs](https://example.com/a.pdf).",
    ].join("\n");

    expect(
      extractLinearUploadReferences(markdown).map((reference) => ({
        image: reference.image,
        label: reference.label,
        url: reference.url.href,
      })),
    ).toEqual([
      {
        image: true,
        label: "screenshot",
        url: "https://uploads.linear.app/acme/one/image.png?signature=one",
      },
      {
        image: true,
        label: "diagram",
        url: "https://uploads.linear.app/acme/two/diagram.jpg?signature=two",
      },
      {
        image: false,
        label: "report.pdf",
        url: "https://uploads.linear.app/acme/three/report.pdf",
      },
    ]);
  });
});

describe("attachLinearInboundUploads", () => {
  it("fetches image bytes with the resolved credential and response media type", async () => {
    const token = vi.fn().mockResolvedValue("linear-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "Image/PNG; charset=binary" },
      }),
    );

    const content = await attachLinearInboundUploads({
      content:
        "Review ![screenshot](https://uploads.linear.app/acme/one/image.png?signature=secret).",
      credentials: { accessToken: token },
      fetch: fetchMock,
    });

    expect(token).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://uploads.linear.app/acme/one/image.png?signature=secret");
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    expect(new Headers(init.headers).get("accept")).toBe("image/*");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer linear-token");

    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ text: "Review screenshot.", type: "text" });
    const file = content[1] as FilePart;
    expect(file.type).toBe("file");
    expect(file.mediaType).toBe("image/png");
    expect(Buffer.isBuffer(file.data)).toBe(true);
    expect(file.data).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("fetches an uploaded file link with its response media type and name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }),
      );

    const content = await attachLinearInboundUploads({
      content: "See [report.pdf](https://uploads.linear.app/acme/one/report.pdf).",
      credentials: { accessToken: "linear-token" },
      fetch: fetchMock,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("accept")).toBe("*/*");
    expect(content).toEqual([
      { text: "See report.pdf.", type: "text" },
      {
        data: Buffer.from("%PDF-1.4"),
        filename: "report.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);
  });

  it("leaves a note for a file link when Linear answers with an HTML page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>", { headers: { "content-type": "text/html" } }));

    await expect(
      attachLinearInboundUploads({
        content: "See [report.pdf](https://uploads.linear.app/acme/one/report.pdf).",
        credentials: { accessToken: "linear-token" },
        fetch: fetchMock,
      }),
    ).resolves.toEqual([
      { text: "See report.pdf.", type: "text" },
      { text: "Attachment report.pdf could not be retrieved.", type: "text" },
    ]);
  });

  it("keeps surrounding text and untrusted markdown, and notes uploads it can't read", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes("/attached.png")) {
        return new Response(new Uint8Array([7, 8]), {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("not an image", {
        headers: { "content-type": "text/plain" },
      });
    });
    const nonImage = "![document](https://uploads.linear.app/acme/two/document.txt?signature=two)";
    const hostile = "![external](https://images.example.com/external.png)";

    const content = await attachLinearInboundUploads({
      content:
        `Before ![attached](https://uploads.linear.app/acme/one/attached.png?signature=one) ` +
        `between ${nonImage} after ${hostile}.`,
      credentials: { accessToken: "linear-token" },
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(content).toHaveLength(3);
    expect((content[0] as TextPart).text).toBe(
      `Before attached between document after ${hostile}.`,
    );
    expect((content[1] as FilePart).data).toEqual(Buffer.from([7, 8]));
    expect(content[2]).toEqual({
      text: "Attachment document could not be retrieved.",
      type: "text",
    });
  });

  it("notes trusted uploads that fail, redirect, or are not images", async () => {
    const markdown = [
      "![failed](https://uploads.linear.app/acme/one/failed.png)",
      "![redirect](https://uploads.linear.app/acme/two/redirect.png)",
      "![text](https://uploads.linear.app/acme/three/readme.txt)",
    ].join(" ");
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/failed.png")) throw new Error("network failure");
      if (href.includes("/redirect.png")) {
        return new Response(null, {
          headers: { location: "https://attacker.example/image.png" },
          status: 302,
        });
      }
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    });

    await expect(
      attachLinearInboundUploads({
        content: markdown,
        credentials: { accessToken: "linear-token" },
        fetch: fetchMock,
      }),
    ).resolves.toEqual([
      { text: "failed redirect text", type: "text" },
      ...["failed", "redirect", "text"].map((label) => ({
        text: `Attachment ${label} could not be retrieved.`,
        type: "text",
      })),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });

  it("never resolves or forwards credentials for hostile lookalike URLs", async () => {
    const markdown = [
      "![suffix](https://uploads.linear.app.attacker.example/image.png)",
      "![userinfo](https://uploads.linear.app@attacker.example/image.png)",
      "![trusted-userinfo](https://attacker@uploads.linear.app/image.png)",
      "![http](http://uploads.linear.app/image.png)",
      "![port](https://uploads.linear.app:444/image.png)",
    ].join(" ");
    const token = vi.fn().mockResolvedValue("linear-token");
    const fetchMock = vi.fn();

    await expect(
      attachLinearInboundUploads({
        content: markdown,
        credentials: { accessToken: token },
        fetch: fetchMock,
      }),
    ).resolves.toBe(markdown);
    expect(token).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
