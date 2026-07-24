import type { FilePart, TextPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  attachLinearInboundImages,
  extractLinearUploadImageReferences,
} from "#public/channels/linear/inbound-images.js";

describe("extractLinearUploadImageReferences", () => {
  it("extracts trusted Linear markdown images and ignores ordinary image hosts", () => {
    const markdown = [
      'First ![screenshot](https://uploads.linear.app/acme/one/image.png?signature=one "One").',
      "Second ![diagram](<https://uploads.linear.app/acme/two/diagram.jpg?signature=two>).",
      "External ![chart](https://images.example.com/chart.png).",
    ].join("\n");

    expect(
      extractLinearUploadImageReferences(markdown).map((reference) => ({
        altText: reference.altText,
        url: reference.url.href,
      })),
    ).toEqual([
      {
        altText: "screenshot",
        url: "https://uploads.linear.app/acme/one/image.png?signature=one",
      },
      {
        altText: "diagram",
        url: "https://uploads.linear.app/acme/two/diagram.jpg?signature=two",
      },
    ]);
  });
});

describe("attachLinearInboundImages", () => {
  it("fetches image bytes with the resolved credential and response media type", async () => {
    const token = vi.fn().mockResolvedValue("linear-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "Image/PNG; charset=binary" },
      }),
    );

    const content = await attachLinearInboundImages({
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

  it("retains surrounding and fallback markdown in mixed content", async () => {
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

    const content = await attachLinearInboundImages({
      content:
        `Before ![attached](https://uploads.linear.app/acme/one/attached.png?signature=one) ` +
        `between ${nonImage} after ${hostile}.`,
      credentials: { accessToken: "linear-token" },
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(content).toHaveLength(2);
    expect((content[0] as TextPart).text).toBe(
      `Before attached between ${nonImage} after ${hostile}.`,
    );
    expect((content[1] as FilePart).data).toEqual(Buffer.from([7, 8]));
  });

  it("preserves markdown when trusted downloads fail, redirect, or are not images", async () => {
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
      attachLinearInboundImages({
        content: markdown,
        credentials: { accessToken: "linear-token" },
        fetch: fetchMock,
      }),
    ).resolves.toBe(markdown);
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
      attachLinearInboundImages({
        content: markdown,
        credentials: { accessToken: token },
        fetch: fetchMock,
      }),
    ).resolves.toBe(markdown);
    expect(token).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
