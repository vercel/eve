import assert, {
  deepEqual as deq,
  equal as eq,
  rejects as rej,
  throws as thr,
} from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import * as M from "../../extension/lib/media.ts";
import * as Mod from "../../extension/lib/model.ts";
import { resolveConfiguredStorage } from "../../extension/lib/storage/default.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import { normalizeStorageKey } from "../../extension/lib/storage/key.ts";
import { verifyGatewayWebhookSignature } from "../../extension/lib/webhook.ts";
import * as H from "../helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const ftyp = (br: string) => {
  const b = new Uint8Array(16);
  b[3] = 0x10;
  b.set(enc(`ftyp${br}`), 4);
  return b;
};
const sign = (sec: string, ts: number, body: string | Uint8Array) => {
  const h = createHmac("sha256", sec).update(`${ts}.`, "utf8");
  return (typeof body === "string" ? h.update(body, "utf8") : h.update(body)).digest("hex");
};
const pubDns: M.DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const safe = (u: string, lookup = pubDns) => M.assertSafePublicUrl(u, { lookup });
const dl = (url: string, opts: Partial<Parameters<typeof M.downloadVideoBytes>[1]>) =>
  M.downloadVideoBytes(url, {
    maxBytes: 1024,
    signal: new AbortController().signal,
    lookup: pubDns,
    ...opts,
  });
const failDl = (u: string, o: Parameters<typeof dl>[1], re: RegExp | ((e: unknown) => boolean)) =>
  rej(() => dl(u, o), re);
const mockRes =
  (body: BodyInit | null, status = 200, headers?: Record<string, string>) =>
  async () =>
    new Response(body, { status, headers });

describe("media helpers and SSRF protection", () => {
  test("detectMediaType, MIME/path helpers, aspectRatio, resolution, videoPath, and isUrlLike", () => {
    const okMagic: [Uint8Array, string][] = [
      [H.PNG_BYTES, "image/png"],
      [H.JPEG_BYTES, "image/jpeg"],
      [H.WEBP_BYTES, "image/webp"],
      [H.GIF_BYTES, "image/gif"],
      [enc("GIF87a\x01\x00"), "image/gif"],
      [H.MP4_BYTES, "video/mp4"],
      [H.MOV_BYTES, "video/quicktime"],
      [H.WEBM_BYTES, "video/webm"],
      [H.MP3_BYTES, "audio/mpeg"],
      [new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg"],
      [H.WAV_BYTES, "audio/wav"],
      [enc("OggS\x00\x02\x00\x00"), "audio/ogg"],
      [enc("fLaC\x00\x00\x00\x22"), "audio/flac"],
      [ftyp("M4A "), "audio/mp4"],
      [ftyp("M4B "), "audio/mp4"],
    ];
    for (const [b, exp] of okMagic) eq(M.detectMediaType(b), exp);
    for (const b of [
      ftyp("avif"),
      ftyp("heic"),
      new Uint8Array([]),
      enc("hi"),
      H.PNG_BYTES.slice(0, 4),
    ])
      eq(M.detectMediaType(b), undefined);
    eq(M.mediaTypeForPath("a\\b\\clip.MP4"), "video/mp4");
    eq(M.mediaTypeForPath("dir/.hidden"), undefined);
    eq(M.mediaTypeFromUrl("https://a.test/clip.MP4?s=1"), "video/mp4");
    eq(M.mediaTypeFromUrl("https://a.test/no-ext"), undefined);
    eq(M.extensionForMediaType('VIDEO/WEBM; codecs="vp9"'), ".webm");
    eq(M.extensionForMediaType("video/x-matroska"), ".mp4");
    eq(M.extensionForMediaType("application/octet-stream"), ".bin");
    const kinds = ["image/png", "VIDEO/MP4; codecs=avc1", "audio/wav", "application/pdf"];
    deq(kinds.map(M.mediaKind), ["image", "video", "audio", "other"]);
    deq([" 9:16 ", "auto", "ADAPTIVE"].map(M.normalizeAspectRatio), [
      "9:16",
      "adaptive",
      "adaptive",
    ]);
    for (const bad of ["", "0:9", "16:0", "-16:9", "16/9", "wide"])
      thr(() => M.normalizeAspectRatio(bad), /Invalid aspectRatio/);
    const resRows =
      "480p|9:16|480x854 720p||1280x720 720p|adaptive|1280x720 720p|1:1|720x720 1080p|16:9|1920x1080 4K|9:16|2160x3840 2160p|1:1|2160x2160 1280X720|9:16|1280x720";
    for (const row of resRows.split(" ")) {
      const [v, r, exp] = row.split("|");
      const ratio = (r || undefined) as `${number}:${number}` | "adaptive" | undefined;
      eq(M.normalizeResolution(v, ratio), exp);
    }
    for (const bad of ["", "0x720", "720", "hd"])
      thr(() => M.normalizeResolution(bad), /Invalid resolution/);
    eq(M.videoPath("clip.mp4", 0), "clip.mp4");
    eq(M.videoPath("v/n.v1/clip.mp4", 2), "v/n.v1/clip-2.mp4");
    eq(M.videoPath("v/dir.name/clip", 1), "v/dir.name/clip-1");
    eq(M.videoPath("v\\.clip", 1), "v\\.clip-1");
    const urls =
      "https://a.test/x http://a.test/x ftp://a.test/x file:///a data:image/png;base64,AA==";
    for (const u of urls.split(" ")) eq(M.isUrlLike(u), true, u);
    for (const p of ["C:\\clip.png", "C:/clip.png", "frames/a.png", "/ws/a.png"])
      eq(M.isUrlLike(p), false, p);
  });

  test("assertSafePublicUrl blocks unsafe schemes, local hosts, private IPv4/IPv6 ranges, and private DNS", async () => {
    const blocked =
      "not-a-url http://a.test/v ftp://a.test/v https://u:p@a.test/v https://localhost/v https://a.localhost/v https://a.local/v https://metadata.google.internal/v https://127.0.0.1/v https://2130706433/v https://0x7f000001/v https://0177.0.0.1/v https://10.0.0.5/v https://100.64.0.1/v https://172.16.0.1/v https://192.168.1.10/v https://169.254.169.254/v https://[::1]/v https://[fc00::1]/v https://[fe80::1]/v https://[::ffff:127.0.0.1]/v https://[::ffff:a9fe:a9fe]/v https://[::ffff:0:127.0.0.1]/v https://[2001:db8::1]/v https://[2001::1]/v https://[2002:7f00:1::1]/v";
    for (const u of blocked.split(" ")) await rej(() => safe(u), u);
    const mixDns: M.DnsLookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.2", family: 4 },
    ];
    await rej(() => safe("https://a.test/v", mixDns), /private or reserved IP/);
    await rej(() => safe("https://a.test/v", async () => []), /Could not resolve/);
    const okUrls =
      "https://a.test/c.mp4 https://93.184.216.34/c.mp4 https://[2606:2800:220:1:248:1893:25c8:1946]/c.mp4 https://[::ffff:93.184.216.34]/c.mp4";
    for (const ok of okUrls.split(" ")) eq((await safe(ok)).pathname, "/c.mp4");
  });

  test("downloadVideoBytes validates redirects, size caps, HTTP statusCode, pinned DNS, and mid-stream aborts", async () => {
    const seen: string[] = [];
    const ok = await dl("https://a.test/s", {
      fetch: async (input, init) => {
        eq(init?.redirect, "manual");
        seen.push(String(input));
        return String(input).endsWith("/s")
          ? new Response(null, { status: 302, headers: { location: "/f.mp4" } })
          : new Response(H.MP4_BYTES, { headers: { "content-type": 'video/mp4; codecs="avc1"' } });
      },
    });
    deq(seen, ["https://a.test/s", "https://a.test/f.mp4"]);
    deq([ok.mediaType, ok.data], ["video/mp4", H.MP4_BYTES]);

    await failDl(
      "https://a.test/r",
      { fetch: mockRes(null, 302, { location: "https://[::1" }) },
      /Invalid redirect Location/,
    );
    let hops = 0;
    const loop = async () =>
      new Response(null, { status: 302, headers: { location: `https://a.test/h${++hops}` } });
    await failDl("https://a.test/h0", { fetch: loop }, /Too many redirects/);
    eq(hops, 6);

    await failDl(
      "https://a.test/b",
      { maxBytes: 100, fetch: mockRes(new Uint8Array(8), 200, { "content-length": "500" }) },
      /Content-Length: 500/,
    );
    let chunks = 0;
    const bigStream = async () =>
      new Response(
        new ReadableStream({
          pull: (c) => void (c.enqueue(new Uint8Array(40)), ++chunks >= 10 && c.close()),
        }),
      );
    await failDl(
      "https://a.test/s",
      { maxBytes: 100, fetch: bigStream },
      /exceeds maximum allowed size of 100/,
    );
    assert.ok(chunks < 10);

    await failDl(
      "https://a.test/e",
      { fetch: mockRes("down", 503) },
      (e) => e instanceof Error && Reflect.get(e, "statusCode") === 503,
    );

    let rebinds = 0;
    const rebind: M.DnsLookupFn = async () => (
      rebinds++,
      [{ address: "169.254.169.254", family: 4 }]
    );
    const noFetch = { maxBytes: 1024, signal: new AbortController().signal, lookup: rebind };
    await rej(
      () => M.downloadVideoBytes("https://rebind.test/c.mp4", noFetch),
      /private or reserved IP/,
    );
    eq(rebinds, 1);

    const ctrl = new AbortController();
    const stall = async () =>
      new Response(
        new ReadableStream({
          start(sc) {
            sc.enqueue(new Uint8Array([1, 2, 3, 4]));
            queueMicrotask(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")));
          },
        }),
      );
    await failDl(
      "https://a.test/st",
      { signal: ctrl.signal, fetch: stall },
      (e) => e instanceof Error && e.name === "TimeoutError",
    );
  });
});

describe("model resolution, webhook verification, and in-memory storage", () => {
  test("model allowlists, alias catalogs, custom models, AI_SDK_DEFAULT_PROVIDER, gateway options, and resolveJobModel", () => {
    const rc = Mod.resolveConfiguredModel;
    const fast = H.createAsyncVideoModel({ modelId: "p/fast", specificationVersion: "v3" }).model;
    const cinema = H.createSyncVideoModel({ modelId: "p/cinema" }).model;
    deq([Mod.isVideoModelLike(fast), Mod.isVideoModelLike(cinema)], [true, true]);
    const badModels = [
      null,
      "s",
      {},
      { specificationVersion: "v2", provider: "p", modelId: "m", doGenerate: async () => ({}) },
      { specificationVersion: "v4", provider: "p", modelId: "m", doStart: async () => ({}) },
    ];
    for (const bad of badModels) eq(Mod.isVideoModelLike(bad), false);

    eq(rc({}).modelId, Mod.DEFAULT_VIDEO_MODEL);
    eq(rc({ model: fast }).model, fast);
    thr(() => rc({ model: fast }, "other/id"), /requires "models" config/);

    const list = { models: ["google/veo-3.1-fast-generate-001", "klingai/kling-v2.6-pro"] };
    eq(rc(list).modelId, "google/veo-3.1-fast-generate-001");
    eq(rc(list, "klingai/kling-v2.6-pro").modelId, "klingai/kling-v2.6-pro");
    thr(() => rc(list, "openai/sora-2"), /is not allowed/);

    const aliases = { model: "cinema", models: { fast, cinema } };
    eq(rc(aliases).model, cinema);
    eq(rc(aliases, "fast").model, fast);
    eq(rc(aliases, "p/fast").model, fast);
    thr(() => rc(aliases, "draft"), /is not allowed/);
    eq(Mod.resolveJobModel(aliases, "fast").model, fast);
    eq(Mod.resolveJobModel(aliases, "p/fast").model, fast);

    const k = "AI_SDK_DEFAULT_PROVIDER";
    const prev = Reflect.get(globalThis, k);
    const reqs: string[] = [];
    try {
      Reflect.set(globalThis, k, { videoModel: (id: string) => (reqs.push(id), fast) });
      eq(rc({ model: "acme/v1" }).model, fast);
      eq(Mod.resolveJobModel({}, "acme/job").model, fast);
      deq(reqs, ["acme/v1", "acme/job"]);
      const gwOpts = { apiKey: "k", baseURL: "https://gw.test/v1", headers: { "x-t": "1" } };
      const gw = rc({ model: "acme/v2", gateway: gwOpts });
      eq(gw.modelId, "acme/v2");
      assert.notEqual(gw.model, fast);
      Reflect.set(globalThis, k, { videoModel: () => ({ invalid: true }) });
      thr(() => rc({ model: "acme/bad" }), /invalid video model/);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(globalThis, k);
      else Reflect.set(globalThis, k, prev);
    }
  });

  test("verifyGatewayWebhookSignature covers valid/rotated signatures, replay window, tampering, and malformed headers", () => {
    const [sec, now, body] = ["whsec_k", 1_700_000_000, '{"event":"video.completed"}'];
    const [sig, old] = [sign(sec, now, body), sign("whsec_old", now, body)];
    const chk = (h: string, b: string | Uint8Array = body, s = sec, maxAge?: number) =>
      verifyGatewayWebhookSignature(h, b, s, {
        nowSeconds: now,
        ...(maxAge !== undefined && { maxAgeSeconds: maxAge }),
      });

    eq(chk(`t=${now},v1=${sig}`), true);
    eq(chk(`t=${now},v1=${sig.toUpperCase()}`, enc(body)), true);
    eq(chk(`t=${now},v1=${old},v1=${sig}`), true);
    eq(chk(`t=${now - 300},v1=${sign(sec, now - 300, body)}`), true);
    eq(chk(`t=${now},v1=${sig}`, `${body} `), false);
    eq(chk(`t=${now},v1=${sig}`, body, "wrong"), false);
    eq(chk(`t=${now},v1=${sig}`, body, ""), false);
    eq(chk(`t=${now - 301},v1=${sign(sec, now - 301, body)}`), false);
    eq(chk(`t=${now + 301},v1=${sign(sec, now + 301, body)}`), false);
    eq(chk(`t=${now - 31},v1=${sign(sec, now - 31, body)}`, body, sec, 30), false);
    const bads = ` v1=${sig} t=${now} t=${now},v1= t=x,v1=${sig} t=${now},t=${now},v1=${sig} t=${now},v1=${sig.slice(0, -2)} t=${now},v1=${"z".repeat(64)} t=${now},v2=${sig}`;
    for (const bad of bads.split(" ")) eq(chk(bad), false, bad);
  });

  test("inMemory isolation/guards and resolveConfiguredStorage env matrix", async () => {
    const badKeys = ["", ..."/a.mp4 a/ ../a.mp4 a/../b.mp4 a//b.mp4 a\\b.mp4 a\x00.mp4".split(" ")];
    for (const bad of badKeys) thr(() => normalizeStorageKey(bad), TypeError, bad);
    const s = inMemory({ baseUrl: "https://a.test/m///" });
    const sig = new AbortController().signal;
    const src = Uint8Array.from(H.MP4_BYTES);
    const put = (st: ReturnType<typeof inMemory>, key: string, data = src, signal = sig) =>
      st.put({ key, data, mediaType: "video/mp4", filename: "a.mp4", signal });
    const stored = await put(s, "videos/a.mp4");
    deq([stored.url, stored.visibility], ["https://a.test/m/videos/a.mp4", "public"]);
    src[0] = 0x99;
    const loaded = await s.get({ key: "videos/a.mp4", signal: sig });
    deq(loaded?.data, H.MP4_BYTES);
    loaded!.data[0] = 0xaa;
    deq((await s.get({ key: "videos/a.mp4", signal: sig }))?.data, H.MP4_BYTES);
    await s.delete({ key: "videos/a.mp4", signal: sig });
    eq(await s.get({ key: "videos/a.mp4", signal: sig }), null);
    const priv = inMemory({ baseUrl: "https://a.test/p", visibility: "private" });
    eq((await put(priv, "b.mp4", H.MP4_BYTES)).visibility, "private");
    thr(() => inMemory({ baseUrl: "   " }), TypeError);
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    await rej(() => put(s, "c.mp4", H.MP4_BYTES, ac.signal), /cancelled/);
    await rej(() => s.get({ key: "c.mp4", signal: ac.signal }), /cancelled/);
    await rej(() => s.delete({ key: "c.mp4", signal: ac.signal }), /cancelled/);
    await H.withCleanStorageEnv(() => {
      eq(resolveConfiguredStorage(undefined), undefined);
      H.clearStorageEnv({ EVE_VIDEO_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_s_k", EVE_DEV: "1" });
      eq(resolveConfiguredStorage(s), s);
      eq(resolveConfiguredStorage(false), undefined);
      const envs = [
        { EVE_VIDEO_BLOB_STORE_ID: "store_a" },
        { VERCEL: "1", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_s_k" },
        { VERCEL: "1", BLOB_STORE_ID: "store_v" },
      ];
      for (const env of envs) {
        H.clearStorageEnv(env);
        eq(typeof resolveConfiguredStorage(undefined)?.put, "function");
      }
      H.clearStorageEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_s_k" });
      eq(resolveConfiguredStorage(undefined), undefined);
    });
  });
});
