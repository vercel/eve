import assert, {
  deepEqual as deq,
  equal as eq,
  rejects as rej,
  throws as thr,
} from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveConfiguredStorage } from "../../extension/lib/storage/default.ts";
import { localDisk } from "../../extension/lib/storage/local-disk.ts";
import type { VideoStorage } from "../../extension/lib/storage/types.ts";
import { vercelBlob } from "../../extension/lib/storage/vercel-blob.ts";
import { MP3_BYTES, MP4_BYTES, WEBM_BYTES, withCleanStorageEnv } from "../helpers.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UNDICI = Symbol.for("undici.globalDispatcher.1");
const SIG = new AbortController().signal;

const putItem = (
  s: VideoStorage,
  key: string,
  data = MP4_BYTES,
  mediaType = "video/mp4",
  extra: { ttlDays?: number; signal?: AbortSignal } = {},
) =>
  s.put({
    key,
    data,
    mediaType,
    filename: key.split("/").pop()!,
    signal: extra.signal ?? SIG,
    ...(extra.ttlDays !== undefined && { ttlDays: extra.ttlDays }),
  });
const getItem = (s: VideoStorage, key: string, signal = SIG) => s.get!({ key, signal });

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe("localDisk filesystem storage adapter", () => {
  test("writes atomically, round-trips MP4/MP3 MIME, guards traversal/URL/abort, and activates under EVE_DEV=1", async () => {
    const root = await mkdtemp(join(ROOT, ".tmp-test-"));
    try {
      const s = localDisk({ directory: root, publicBaseUrl: "https://files.test/videos///" });
      const stored = await putItem(s, "nested/2026-11-26/clip.mp4");
      eq(stored.key, "nested/2026-11-26/clip.mp4");
      eq(stored.path, join(root, "nested", "2026-11-26", "clip.mp4"));
      eq(stored.url, "https://files.test/videos/nested/2026-11-26/clip.mp4");
      eq(stored.visibility, "public");
      deq(await readdir(join(root, "nested", "2026-11-26")), ["clip.mp4"]);

      const loaded = await getItem(s, "nested/2026-11-26/clip.mp4");
      eq(loaded?.mediaType, "video/mp4");
      deq(loaded?.data, MP4_BYTES);

      await putItem(s, "audio/track.mp3", MP3_BYTES, "audio/mpeg");
      const audio = await getItem(s, "audio/track.mp3");
      eq(audio?.mediaType, "audio/mpeg");
      deq(audio?.data, MP3_BYTES);

      eq(await getItem(s, "nested/missing.mp4"), null);
      await s.delete!({ key: "nested/2026-11-26/clip.mp4", signal: SIG });
      eq(await getItem(s, "nested/2026-11-26/clip.mp4"), null);

      thr(() => localDisk({ directory: "   " }), TypeError);
      for (const bad of ["not-a-url", "file:///tmp/v", "https://a.test/?q=1", "https://a.test/#h"])
        thr(() => localDisk({ directory: root, publicBaseUrl: bad }), TypeError);
      await rej(() => putItem(s, "../outside.mp4"), TypeError);

      const ac = new AbortController();
      ac.abort(new Error("aborted-disk"));
      await rej(
        () => putItem(s, "c.mp4", MP4_BYTES, "video/mp4", { signal: ac.signal }),
        /aborted-disk/,
      );
      await rej(() => getItem(s, "c.mp4", ac.signal), /aborted-disk/);
      await rej(() => s.delete!({ key: "c.mp4", signal: ac.signal }), /aborted-disk/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }

    await withCleanStorageEnv(
      async () => {
        const dev = resolveConfiguredStorage(undefined)!;
        const key = `test-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
        try {
          assert.ok((await putItem(dev, key)).path?.includes("eve-videos"));
          deq((await getItem(dev, key))?.data, MP4_BYTES);
        } finally {
          await dev.delete!({ key, signal: SIG });
        }
      },
      { EVE_DEV: "1" },
    );
  });
});

describe("vercelBlob storage adapter over local HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let prevDisp: unknown;
  let nextGetStatus: number | undefined;
  const blobs = new Map<string, { data: Buffer; ct: string }>();
  const mpu = new Map<string, { parts: Buffer[]; ct: string }>();
  const reqs: { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }[] =
    [];
  const rerouted: string[] = [];

  before(async () => {
    const json = (res: ServerResponse, st: number, body: unknown) =>
      void (res.writeHead(st, { "content-type": "application/json" }),
      res.end(JSON.stringify(body)));
    server = createServer((req, res) => {
      void (async () => {
        const body = await readBody(req);
        const [method, rawUrl] = [req.method ?? "GET", req.url ?? "/"];
        reqs.push({ method, url: rawUrl, headers: req.headers, body });
        const parsed = new URL(rawUrl, baseUrl);
        const p = parsed.searchParams.get("pathname") ?? "";
        const ct = String(req.headers["x-content-type"] ?? "application/octet-stream");
        const access = String(req.headers["x-vercel-blob-access"] ?? "public");
        const sid = String(req.headers["x-vercel-blob-store-id"] ?? "store123");
        const meta = (pathname: string, contentType: string, etag: string) => {
          const url = `https://${sid}.${access}.blob.vercel-storage.com/${pathname}`;
          return {
            url,
            downloadUrl: `${url}?download=1`,
            pathname,
            contentType,
            contentDisposition: "inline",
            etag,
          };
        };
        if (method === "PUT" && parsed.pathname === "/") {
          blobs.set(p, { data: body, ct });
          const ttl = Number(req.headers["x-ttl-days"]);
          const out: Record<string, unknown> = meta(p, ct, '"e1"');
          if (Number.isFinite(ttl) && ttl > 0)
            out.expiresAt = new Date(Date.UTC(2026, 11, 1 + ttl)).toISOString();
          return json(res, 200, out);
        }
        if (method === "POST" && parsed.pathname === "/mpu") {
          const act = String(req.headers["x-mpu-action"] ?? "");
          const id = String(req.headers["x-mpu-upload-id"] ?? "");
          if (act === "create") {
            const uploadId = `mpu_${mpu.size + 1}`;
            return (mpu.set(uploadId, { parts: [], ct }), json(res, 200, { uploadId, key: p }));
          }
          if (act === "upload") {
            mpu.get(id)?.parts.push(body);
            return json(res, 200, { etag: `"p-${req.headers["x-mpu-part-number"] ?? "1"}"` });
          }
          const s = mpu.get(id);
          const finalCt = s?.ct ?? ct;
          blobs.set(p, { data: s ? Buffer.concat(s.parts) : Buffer.alloc(0), ct: finalCt });
          mpu.delete(id);
          return json(res, 200, meta(p, finalCt, '"mpu"'));
        }
        if (method === "POST" && parsed.pathname === "/delete") {
          const { urls } = JSON.parse(body.toString("utf8")) as { urls: string[] };
          for (const u of urls)
            blobs.delete((u.startsWith("http") ? new URL(u).pathname : u).replace(/^\/+/, ""));
          return json(res, 200, {});
        }
        if (method === "GET") {
          if (nextGetStatus !== undefined) {
            const st = nextGetStatus;
            nextGetStatus = undefined;
            return void (res.writeHead(st), res.end(st === 304 ? undefined : "Error"));
          }
          const e = blobs.get(parsed.pathname.replace(/^\/+/, ""));
          if (!e) return void (res.writeHead(404), res.end("Not Found"));
          const h = {
            "content-type": e.ct,
            "content-length": String(e.data.byteLength),
            etag: '"e"',
          };
          return void (res.writeHead(200, h), res.end(e.data));
        }
        return json(res, 404, { error: { code: "not_found", message: "not found" } });
      })();
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    prevDisp = Reflect.get(globalThis, UNDICI);
    const underlying = prevDisp as { dispatch(o: Record<string, unknown>, h: unknown): boolean };
    Reflect.set(globalThis, UNDICI, {
      dispatch(opts: Record<string, unknown>, h: unknown) {
        const origin = opts.origin !== undefined ? String(opts.origin) : "";
        if (origin.endsWith(".blob.vercel-storage.com")) {
          rerouted.push(origin);
          return underlying.dispatch({ ...opts, origin: baseUrl }, h);
        }
        return underlying.dispatch(opts, h);
      },
    });
  });

  afterEach(() => {
    blobs.clear();
    mpu.clear();
    reqs.length = 0;
    rerouted.length = 0;
    nextGetStatus = undefined;
  });
  after(async () => {
    if (prevDisp !== undefined) Reflect.set(globalThis, UNDICI, prevDisp);
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
  const withBlob = (fn: () => Promise<void>) =>
    withCleanStorageEnv(fn, { VERCEL_BLOB_API_URL: baseUrl });

  test("round-trips overlapping prefix/key, headers, ttlDays, private access, 404/304/500, and delete", () =>
    withBlob(async () => {
      const pub = vercelBlob({
        token: "vercel_blob_rw_storepref_sec",
        prefix: "videos",
        ttlDays: 7,
        cacheControlMaxAge: 3600,
      });
      const stored = await putItem(pub, "videos/2026-11-26/clip.mp4");
      const h0 = reqs[0].headers;
      const baseBlob = "https://storepref.public.blob.vercel-storage.com";
      eq(stored.key, "videos/2026-11-26/clip.mp4");
      eq(stored.url, `${baseBlob}/videos/videos/2026-11-26/clip.mp4`);
      eq(stored.visibility, "public");
      eq(stored.expiresAt, new Date(Date.UTC(2026, 11, 8)).toISOString());
      eq(h0.authorization, "Bearer vercel_blob_rw_storepref_sec");
      deq(
        [h0["x-vercel-blob-access"], h0["x-cache-control-max-age"], h0["x-ttl-days"]],
        ["public", "3600", "7"],
      );
      const loaded = await getItem(pub, stored.key);
      deq([loaded?.key, loaded?.data], ["videos/2026-11-26/clip.mp4", MP4_BYTES]);
      deq(rerouted, [baseBlob]);
      eq(await getItem(pub, "missing.mp4"), null);
      nextGetStatus = 304;
      await rej(() => getItem(pub, stored.key), /304 without a video stream/);
      nextGetStatus = 500;
      await rej(() => getItem(pub, stored.key), /Failed to fetch blob: 500/);
      await pub.delete!({ key: stored.key, signal: SIG });
      deq(JSON.parse(reqs[reqs.length - 1].body.toString("utf8")), {
        urls: ["videos/videos/2026-11-26/clip.mp4"],
      });
      eq(await getItem(pub, stored.key), null);
      const priv = vercelBlob({ access: "private", token: "vercel_blob_rw_storepriv_sec" });
      const ps = await putItem(priv, "secret/clip.webm", WEBM_BYTES, "video/webm", { ttlDays: 2 });
      const hp = reqs[reqs.length - 1].headers;
      deq(
        [ps.visibility, hp["x-vercel-blob-access"], hp["x-ttl-days"]],
        ["private", "private", "2"],
      );
    }));

  test("credential precedence (EVE_VIDEO_BLOB_READ_WRITE_TOKEN vs BLOB_READ_WRITE_TOKEN vs OIDC) and multipart >5 MiB", () =>
    withBlob(async () => {
      Object.assign(process.env, {
        VERCEL: "1",
        EVE_VIDEO_BLOB_STORE_ID: "store_video_only",
        EVE_VIDEO_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_storevid_sec",
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_storeother_sec",
      });
      const adapter = vercelBlob();
      await putItem(adapter, "clip.mp4");
      eq(reqs[0].headers.authorization, "Bearer vercel_blob_rw_storevid_sec");
      const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const jwt = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: "p", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
      process.env.VERCEL_OIDC_TOKEN = jwt;
      await putItem(adapter, "clip-oidc.mp4");
      eq(reqs[1].headers.authorization, `Bearer ${jwt}`);
      eq(reqs[1].headers["x-vercel-blob-store-id"], "video_only");
      reqs.length = 0;
      const big = new Uint8Array(5 * 1024 * 1024 + 1);
      big.set(MP4_BYTES);
      const auto = vercelBlob({ token: "vercel_blob_rw_storempu_sec", prefix: "large" });
      eq((await putItem(auto, "big.mp4", big)).bytes, big.byteLength);
      const actions = reqs
        .filter((r) => r.url.startsWith("/mpu?"))
        .map((r) => r.headers["x-mpu-action"]);
      deq(actions, ["create", "upload", "complete"]);
      reqs.length = 0;
      const single = vercelBlob({
        token: "vercel_blob_rw_storempu_sec",
        prefix: "large",
        multipart: false,
      });
      await putItem(single, "big-single.mp4", big);
      deq([reqs.length, reqs[0].method], [1, "PUT"]);
      assert.ok(reqs[0].url.startsWith("/?pathname=large%2Fbig-single.mp4"));
    }));
});
