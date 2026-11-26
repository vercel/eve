import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assertSafePublicUrl,
  detectMediaType,
  downloadVideoBytes,
  extensionForMediaType,
  isUrlLike,
  mediaKind,
  mediaTypeFromUrl,
  normalizeAspectRatio,
  normalizeResolution,
  videoPath,
  type DnsLookupFn,
} from "../../extension/lib/media.ts";
import {
  FLAC_BYTES,
  GIF_BYTES,
  JPEG_BYTES,
  M4A_BYTES,
  MOV_BYTES,
  MP3_BYTES,
  MP4_BYTES,
  OGG_BYTES,
  PNG_BYTES,
  WAV_BYTES,
  WEBM_BYTES,
  WEBP_BYTES,
} from "../helpers.ts";

function isobmffWithBrand(brand: string): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[3] = 0x10;
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  return bytes;
}

describe("media format detection and classification", () => {
  test("detectMediaType identifies image, video, and audio magic bytes and rejects still ISOBMFF brands", () => {
    const cases: readonly (readonly [string, Uint8Array, string | undefined])[] = [
      ["png", PNG_BYTES, "image/png"],
      ["jpeg", JPEG_BYTES, "image/jpeg"],
      ["webp", WEBP_BYTES, "image/webp"],
      ["gif89a", GIF_BYTES, "image/gif"],
      ["gif87a", new TextEncoder().encode("GIF87a\x01\x00"), "image/gif"],
      ["mp4", MP4_BYTES, "video/mp4"],
      ["mov", MOV_BYTES, "video/quicktime"],
      ["webm", WEBM_BYTES, "video/webm"],
      ["mp3-id3", MP3_BYTES, "audio/mpeg"],
      ["mp3-sync", new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg"],
      ["wav", WAV_BYTES, "audio/wav"],
      ["ogg", OGG_BYTES, "audio/ogg"],
      ["flac", FLAC_BYTES, "audio/flac"],
      ["m4a", M4A_BYTES, "audio/mp4"],
      ["m4b", isobmffWithBrand("M4B "), "audio/mp4"],
      ["avif-still", isobmffWithBrand("avif"), undefined],
      ["heic-still", isobmffWithBrand("heic"), undefined],
      ["empty", new Uint8Array([]), undefined],
      ["plain-text", new TextEncoder().encode("hello world"), undefined],
      ["truncated-png", PNG_BYTES.slice(0, 4), undefined],
    ];

    for (const [label, bytes, expected] of cases) {
      assert.equal(detectMediaType(bytes), expected, label);
    }
  });

  test("extensionForMediaType normalizes MIME parameters and falls back by top-level type", () => {
    assert.equal(extensionForMediaType('VIDEO/WEBM; codecs="vp9"'), ".webm");
    assert.equal(extensionForMediaType("image/jpeg"), ".jpg");
    assert.equal(extensionForMediaType("audio/mp4"), ".m4a");
    assert.equal(extensionForMediaType("video/x-matroska"), ".mp4");
    assert.equal(extensionForMediaType("application/octet-stream"), ".bin");
  });

  test("mediaTypeFromUrl infers media types from URL pathname extensions", () => {
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/a/b/clip.MP4?sig=1"), "video/mp4");
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/frame.jpeg"), "image/jpeg");
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/sound.m4a#t=2"), "audio/mp4");
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/no-extension"), undefined);
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/.hidden"), undefined);
    assert.equal(mediaTypeFromUrl("https://cdn.example.com/file.unknown"), undefined);
    assert.equal(mediaTypeFromUrl("not-a-url"), undefined);
  });

  test("mediaKind classifies image, video, audio, and other media types", () => {
    assert.equal(mediaKind("image/png"), "image");
    assert.equal(mediaKind("VIDEO/MP4; codecs=avc1"), "video");
    assert.equal(mediaKind("audio/wav"), "audio");
    assert.equal(mediaKind("application/pdf"), "other");
    assert.equal(mediaKind(""), "other");
  });

  test("isUrlLike distinguishes URL schemes from local and Windows drive paths", () => {
    for (const url of [
      "https://cdn.example.com/a.png",
      "http://example.com/a.png",
      "ftp://example.com/a.png",
      "file:///etc/passwd",
      "data:image/png;base64,AA==",
    ]) {
      assert.equal(isUrlLike(url), true, url);
    }

    for (const localPath of [
      "C:\\clip.png",
      "C:/clip.png",
      "frames/opening.png",
      "/workspace/frames/opening.png",
    ]) {
      assert.equal(isUrlLike(localPath), false, localPath);
    }
  });
});

describe("aspect ratio, resolution, and output path helpers", () => {
  test("normalizeAspectRatio accepts explicit ratios and adaptive aliases", () => {
    assert.equal(normalizeAspectRatio("16:9"), "16:9");
    assert.equal(normalizeAspectRatio(" 9:16 "), "9:16");
    assert.equal(normalizeAspectRatio("1:1"), "1:1");
    assert.equal(normalizeAspectRatio("auto"), "adaptive");
    assert.equal(normalizeAspectRatio("ADAPTIVE"), "adaptive");
  });

  test("normalizeAspectRatio rejects malformed ratios", () => {
    for (const invalid of ["", "0:9", "16:0", "-16:9", "16/9", "16:9:1", "wide"]) {
      assert.throws(() => normalizeAspectRatio(invalid), /Invalid aspectRatio/, invalid);
    }
  });

  test("normalizeResolution resolves presets by orientation and accepts explicit WxH", () => {
    const cases: readonly (readonly [
      string,
      `${number}:${number}` | "adaptive" | undefined,
      string,
    ])[] = [
      ["480p", "16:9", "854x480"],
      ["480p", "9:16", "480x854"],
      ["480p", "1:1", "480x480"],
      ["720p", undefined, "1280x720"],
      ["720p", "adaptive", "1280x720"],
      ["720p", "9:16", "720x1280"],
      ["720p", "1:1", "720x720"],
      ["1080p", "16:9", "1920x1080"],
      ["1080p", "9:16", "1080x1920"],
      ["1080p", "1:1", "1080x1080"],
      ["4k", "16:9", "3840x2160"],
      ["4K", "9:16", "2160x3840"],
      ["2160p", "1:1", "2160x2160"],
      ["1280x720", "9:16", "1280x720"],
      [" 1920X1080 ", undefined, "1920x1080"],
    ];

    for (const [value, aspectRatio, expected] of cases) {
      assert.equal(normalizeResolution(value, aspectRatio), expected, `${value} @ ${aspectRatio}`);
    }
  });

  test("normalizeResolution rejects invalid values", () => {
    for (const invalid of ["", "0x720", "1280x0", "720", "hd", "1280*720"]) {
      assert.throws(() => normalizeResolution(invalid), /Invalid resolution/, invalid);
    }
  });

  test("videoPath inserts numeric suffixes cleanly across path shapes", () => {
    assert.equal(videoPath("clip.mp4", 0), "clip.mp4");
    assert.equal(videoPath("clip.mp4", 1), "clip-1.mp4");
    assert.equal(videoPath("videos/teaser.mp4", 2), "videos/teaser-2.mp4");
    assert.equal(videoPath("videos/nested.v1/teaser.mp4", 1), "videos/nested.v1/teaser-1.mp4");
    assert.equal(videoPath("videos/teaser", 1), "videos/teaser-1");
    assert.equal(videoPath("videos/dir.name/teaser", 1), "videos/dir.name/teaser-1");
    assert.equal(videoPath(".clip", 1), ".clip-1");
    assert.equal(videoPath("videos/.clip", 1), "videos/.clip-1");
    assert.equal(videoPath("videos\\.clip", 1), "videos\\.clip-1");
  });
});

describe("SSRF validation and safe URL checks", () => {
  test("assertSafePublicUrl blocks non-HTTPS, credentials, local hosts, alternate IPv4 notations, private IPs, and private DNS answers", async () => {
    const blockedUrls = [
      "not-a-url",
      "http://example.com/video.mp4",
      "ftp://example.com/video.mp4",
      "https://user:pass@example.com/video.mp4",
      "https://localhost/video.mp4",
      "https://api.localhost/video.mp4",
      "https://printer.local/video.mp4",
      "https://service.internal/video.mp4",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://127.0.0.1/video.mp4",
      "https://2130706433/video.mp4",
      "https://0x7f000001/video.mp4",
      "https://0177.0.0.1/video.mp4",
      "https://10.0.0.5/video.mp4",
      "https://100.64.0.1/video.mp4",
      "https://172.16.0.1/video.mp4",
      "https://192.168.1.10/video.mp4",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/video.mp4",
      "https://[fc00::1]/video.mp4",
      "https://[fe80::1]/video.mp4",
      "https://[::ffff:127.0.0.1]/video.mp4",
      "https://[::ffff:a9fe:a9fe]/video.mp4",
      "https://[::ffff:0:127.0.0.1]/video.mp4",
      "https://[2001:db8::1]/video.mp4",
    ];

    const publicLookup: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
    for (const url of blockedUrls) {
      await assert.rejects(
        () => assertSafePublicUrl(url, { lookup: publicLookup }),
        `expected rejection for ${url}`,
      );
    }

    const privateDnsLookup: DnsLookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.2", family: 4 },
    ];
    await assert.rejects(
      () => assertSafePublicUrl("https://cdn.example.com/video.mp4", { lookup: privateDnsLookup }),
      /private or reserved IP/,
    );

    const emptyDnsLookup: DnsLookupFn = async () => [];
    await assert.rejects(
      () => assertSafePublicUrl("https://cdn.example.com/video.mp4", { lookup: emptyDnsLookup }),
      /Could not resolve/,
    );
  });

  test("assertSafePublicUrl accepts public HTTPS hosts and literal public IPv4, IPv6, and IPv4-mapped addresses", async () => {
    let queriedHost: string | undefined;
    const lookup: DnsLookupFn = async (hostname) => {
      queriedHost = hostname;
      return [{ address: "93.184.216.34", family: 4 }];
    };

    const resolved = await assertSafePublicUrl("https://cdn.example.com/clip.mp4", { lookup });
    assert.equal(resolved.href, "https://cdn.example.com/clip.mp4");
    assert.equal(queriedHost, "cdn.example.com");

    const literal = await assertSafePublicUrl("https://93.184.216.34/clip.mp4");
    assert.equal(literal.href, "https://93.184.216.34/clip.mp4");

    const literalV6 = await assertSafePublicUrl(
      "https://[2606:2800:220:1:248:1893:25c8:1946]/clip.mp4",
    );
    assert.equal(literalV6.href, "https://[2606:2800:220:1:248:1893:25c8:1946]/clip.mp4");

    const mappedV4 = await assertSafePublicUrl("https://[::ffff:93.184.216.34]/clip.mp4");
    assert.equal(mappedV4.pathname, "/clip.mp4");

    const mappedDns = await assertSafePublicUrl("https://cdn.example.com/mapped.mp4", {
      lookup: async () => [{ address: "::ffff:93.184.216.34", family: 6 }],
    });
    assert.equal(mappedDns.href, "https://cdn.example.com/mapped.mp4");
  });
});

describe("downloadVideoBytes", () => {
  const publicLookup: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

  test("downloads video bytes from a public URL and normalizes content-type", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      assert.equal(init?.redirect, "manual");
      return new Response(MP4_BYTES, {
        status: 200,
        headers: {
          "content-type": 'video/mp4; codecs="avc1"',
          "content-length": String(MP4_BYTES.byteLength),
        },
      });
    };

    const result = await downloadVideoBytes("https://cdn.example.com/clip.mp4", {
      maxBytes: 1024,
      signal: new AbortController().signal,
      fetch: fetchImpl,
      lookup: publicLookup,
    });

    assert.deepEqual(requestedUrls, ["https://cdn.example.com/clip.mp4"]);
    assert.equal(result.mediaType, "video/mp4");
    assert.deepEqual(result.data, MP4_BYTES);
  });

  test("follows safe redirects and rejects redirects targeting private hosts or malformed Location headers", async () => {
    const seen: string[] = [];
    const safeRedirectFetch: typeof fetch = async (input) => {
      const href = String(input);
      seen.push(href);
      if (href === "https://cdn.example.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "/final/clip.mp4" },
        });
      }
      return new Response(MP4_BYTES, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    };

    const result = await downloadVideoBytes("https://cdn.example.com/start", {
      maxBytes: 1024,
      signal: new AbortController().signal,
      fetch: safeRedirectFetch,
      lookup: publicLookup,
    });
    assert.deepEqual(seen, [
      "https://cdn.example.com/start",
      "https://cdn.example.com/final/clip.mp4",
    ]);
    assert.deepEqual(result.data, MP4_BYTES);

    let fetchCount = 0;
    const ssrfRedirectFetch: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/secret.mp4" },
      });
    };

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/start", {
          maxBytes: 1024,
          signal: new AbortController().signal,
          fetch: ssrfRedirectFetch,
          lookup: publicLookup,
        }),
      /private or reserved IP/,
    );
    assert.equal(fetchCount, 1);

    const malformedRedirectFetch: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://[::1" },
      });

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/start", {
          maxBytes: 1024,
          signal: new AbortController().signal,
          fetch: malformedRedirectFetch,
          lookup: publicLookup,
        }),
      /Invalid redirect Location header/,
    );
  });

  test("rejects redirect chains exceeding 5 redirects", async () => {
    let hop = 0;
    const loopFetch: typeof fetch = async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example.com/hop-${hop}` },
      });
    };

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/hop-0", {
          maxBytes: 1024,
          signal: new AbortController().signal,
          fetch: loopFetch,
          lookup: publicLookup,
        }),
      /Too many redirects/,
    );
    assert.equal(hop, 6);
  });

  test("rejects oversized Content-Length and oversized streaming bodies without Content-Length", async () => {
    const declaredTooLargeFetch: typeof fetch = async () =>
      new Response(new Uint8Array(64), {
        status: 200,
        headers: { "content-length": "5000" },
      });

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/big.mp4", {
          maxBytes: 100,
          signal: new AbortController().signal,
          fetch: declaredTooLargeFetch,
          lookup: publicLookup,
        }),
      /Content-Length: 5000/,
    );

    let chunksEmitted = 0;
    const streamingTooLargeFetch: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksEmitted += 1;
          controller.enqueue(new Uint8Array(40).fill(chunksEmitted));
          if (chunksEmitted >= 10) {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    };

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/stream.mp4", {
          maxBytes: 100,
          signal: new AbortController().signal,
          fetch: streamingTooLargeFetch,
          lookup: publicLookup,
        }),
      /exceeds maximum allowed size of 100 bytes/,
    );
    assert.ok(chunksEmitted < 10);
  });

  test("rejects with abort error instead of returning partial bytes when ReadableStream download aborts mid-stream", async () => {
    const controller = new AbortController();
    const stalledFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(new Uint8Array([1, 2, 3, 4]));
            queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
          },
        }),
        { status: 200, headers: { "content-type": "video/mp4" } },
      );

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/stalled.mp4", {
          maxBytes: 1024,
          signal: controller.signal,
          fetch: stalledFetch,
          lookup: publicLookup,
        }),
      (error: unknown) => error instanceof Error && error.name === "TimeoutError",
    );
  });

  test("rejects HTTP error status responses", async () => {
    const errorFetch: typeof fetch = async () => new Response("unavailable", { status: 503 });

    await assert.rejects(
      () =>
        downloadVideoBytes("https://cdn.example.com/clip.mp4", {
          maxBytes: 1024,
          signal: new AbortController().signal,
          fetch: errorFetch,
          lookup: publicLookup,
        }),
      /HTTP 503/,
    );
  });

  test("pinned default HTTPS transport rejects private IPs during socket DNS lookup", async () => {
    let lookupCalls = 0;
    const rebindingLookup: DnsLookupFn = async () => {
      lookupCalls += 1;
      return [{ address: "169.254.169.254", family: 4 }];
    };

    await assert.rejects(
      () =>
        downloadVideoBytes("https://rebind.example.com/clip.mp4", {
          maxBytes: 1024,
          signal: new AbortController().signal,
          lookup: rebindingLookup,
        }),
      /resolves to a private or reserved IP address/,
    );
    assert.equal(lookupCalls, 1);
  });
});
