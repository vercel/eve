import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, test } from "node:test";

import { vercelBlob } from "../../extension/lib/storage/vercel-blob.ts";
import { MP4_BYTES, WEBM_BYTES, withCleanStorageEnv } from "../helpers.ts";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

interface StoredBlobEntry {
  readonly data: Buffer;
  readonly contentType: string;
  readonly access: string;
}

interface UndiciDispatchOptions {
  readonly origin?: string | URL;
  readonly [key: string]: unknown;
}

interface UndiciDispatcher {
  dispatch(opts: UndiciDispatchOptions, handler: unknown): boolean;
}

const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("vercelBlob storage adapter over local HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let previousDispatcher: unknown;
  let nextGetStatusOverride: number | undefined;
  const blobs = new Map<string, StoredBlobEntry>();
  const mpuUploads = new Map<
    string,
    { readonly parts: Buffer[]; readonly contentType: string; readonly access: string }
  >();
  const requests: RecordedRequest[] = [];
  const reroutedOrigins: string[] = [];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(req, res);
    });

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const body = await readBody(req);
      const method = req.method ?? "GET";
      const rawUrl = req.url ?? "/";
      requests.push({
        method,
        url: rawUrl,
        headers: req.headers,
        body,
      });

      const parsed = new URL(rawUrl, baseUrl);

      if (method === "PUT" && parsed.pathname === "/") {
        const pathname = parsed.searchParams.get("pathname");
        if (pathname === null || pathname.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "bad_request", message: "missing pathname" } }));
          return;
        }
        const contentType = String(req.headers["x-content-type"] ?? "application/octet-stream");
        const access = String(req.headers["x-vercel-blob-access"] ?? "public");
        const ttlDaysHeader = req.headers["x-ttl-days"];
        const storeId = String(req.headers["x-vercel-blob-store-id"] ?? "store123");
        blobs.set(pathname, { data: body, contentType, access });

        const blobUrl = `https://${storeId}.${access}.blob.vercel-storage.com/${pathname}`;
        const payload: {
          url: string;
          downloadUrl: string;
          pathname: string;
          contentType: string;
          contentDisposition: string;
          etag: string;
          expiresAt?: string;
        } = {
          url: blobUrl,
          downloadUrl: `${blobUrl}?download=1`,
          pathname,
          contentType,
          contentDisposition: `inline; filename="${pathname.split("/").pop() ?? "video.mp4"}"`,
          etag: '"etag-1"',
        };
        if (ttlDaysHeader !== undefined) {
          const days = Number(ttlDaysHeader);
          if (Number.isFinite(days) && days > 0) {
            payload.expiresAt = new Date(Date.UTC(2026, 11, 1 + days)).toISOString();
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      if (method === "POST" && parsed.pathname === "/mpu") {
        const action = String(req.headers["x-mpu-action"] ?? "");
        const pathname = parsed.searchParams.get("pathname") ?? "";
        const contentType = String(req.headers["x-content-type"] ?? "application/octet-stream");
        const access = String(req.headers["x-vercel-blob-access"] ?? "public");
        const storeId = String(req.headers["x-vercel-blob-store-id"] ?? "store123");

        if (action === "create") {
          const uploadId = `mpu_${mpuUploads.size + 1}`;
          mpuUploads.set(uploadId, { parts: [], contentType, access });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ uploadId, key: pathname }));
          return;
        }
        if (action === "upload") {
          const uploadId = String(req.headers["x-mpu-upload-id"] ?? "");
          const session = mpuUploads.get(uploadId);
          if (session !== undefined) {
            session.parts.push(body);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ etag: `"part-${req.headers["x-mpu-part-number"] ?? "1"}"` }));
          return;
        }
        if (action === "complete") {
          const uploadId = String(req.headers["x-mpu-upload-id"] ?? "");
          const session = mpuUploads.get(uploadId);
          const merged = session !== undefined ? Buffer.concat(session.parts) : Buffer.alloc(0);
          blobs.set(pathname, {
            data: merged,
            contentType: session?.contentType ?? contentType,
            access: session?.access ?? access,
          });
          mpuUploads.delete(uploadId);
          const blobUrl = `https://${storeId}.${access}.blob.vercel-storage.com/${pathname}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              url: blobUrl,
              downloadUrl: `${blobUrl}?download=1`,
              pathname,
              contentType: session?.contentType ?? contentType,
              contentDisposition: `inline; filename="${pathname.split("/").pop() ?? "video.mp4"}"`,
              etag: '"etag-mpu"',
            }),
          );
          return;
        }
      }

      if (method === "POST" && parsed.pathname === "/delete") {
        const parsedBody = JSON.parse(body.toString("utf8")) as {
          readonly urls: readonly string[];
        };
        for (const target of parsedBody.urls) {
          const key = target.startsWith("http")
            ? new URL(target).pathname.replace(/^\/+/, "")
            : target.replace(/^\/+/, "");
          blobs.delete(key);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }

      if (method === "GET") {
        if (nextGetStatusOverride !== undefined) {
          const status = nextGetStatusOverride;
          nextGetStatusOverride = undefined;
          res.writeHead(status, { "content-type": "text/plain" });
          res.end(status === 304 ? undefined : "Error");
          return;
        }
        const key = parsed.pathname.replace(/^\/+/, "");
        const entry = blobs.get(key);
        if (entry === undefined) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not Found");
          return;
        }
        res.writeHead(200, {
          "content-type": entry.contentType,
          "content-length": String(entry.data.byteLength),
          etag: '"etag-1"',
        });
        res.end(entry.data);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "route not found" } }));
    }

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    previousDispatcher = Reflect.get(globalThis, UNDICI_GLOBAL_DISPATCHER);
    assert.equal(typeof previousDispatcher, "object");
    assert.notEqual(previousDispatcher, null);
    const underlying = previousDispatcher as UndiciDispatcher;

    const routingDispatcher: UndiciDispatcher = {
      dispatch(opts, handler) {
        const originText = opts.origin !== undefined ? String(opts.origin) : "";
        if (originText.endsWith(".blob.vercel-storage.com")) {
          reroutedOrigins.push(originText);
          return underlying.dispatch({ ...opts, origin: baseUrl }, handler);
        }
        return underlying.dispatch(opts, handler);
      },
    };
    Reflect.set(globalThis, UNDICI_GLOBAL_DISPATCHER, routingDispatcher);
  });

  afterEach(() => {
    blobs.clear();
    mpuUploads.clear();
    requests.length = 0;
    reroutedOrigins.length = 0;
    nextGetStatusOverride = undefined;
  });

  after(async () => {
    if (previousDispatcher !== undefined) {
      Reflect.set(globalThis, UNDICI_GLOBAL_DISPATCHER, previousDispatcher);
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined ? reject(err) : resolve()));
    });
  });

  const withBlobEnv = (fn: () => Promise<void>) =>
    withCleanStorageEnv(fn, { VERCEL_BLOB_API_URL: baseUrl });

  test("uploads public and private videos with expected headers, unprefixed logical key, ttlDays, and bearer token", () =>
    withBlobEnv(async () => {
      const signal = new AbortController().signal;

      const publicAdapter = vercelBlob({
        token: "vercel_blob_rw_storepub_secret1",
        prefix: "custom/videos",
        ttlDays: 7,
        cacheControlMaxAge: 3600,
      });

      const pubStored = await publicAdapter.put({
        key: "2026-11-26/clip.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "clip.mp4",
        signal,
      });

      assert.equal(pubStored.key, "2026-11-26/clip.mp4");
      assert.equal(
        pubStored.url,
        "https://storepub.public.blob.vercel-storage.com/custom/videos/2026-11-26/clip.mp4",
      );
      assert.equal(pubStored.downloadUrl, `${pubStored.url}?download=1`);
      assert.equal(pubStored.mediaType, "video/mp4");
      assert.equal(pubStored.bytes, MP4_BYTES.byteLength);
      assert.equal(pubStored.visibility, "public");
      assert.equal(pubStored.expiresAt, new Date(Date.UTC(2026, 11, 8)).toISOString());

      const pubReq = requests[0];
      assert.equal(pubReq.method, "PUT");
      assert.equal(pubReq.headers.authorization, "Bearer vercel_blob_rw_storepub_secret1");
      assert.equal(pubReq.headers["x-vercel-blob-access"], "public");
      assert.equal(pubReq.headers["x-content-type"], "video/mp4");
      assert.equal(pubReq.headers["x-add-random-suffix"], "0");
      assert.equal(pubReq.headers["x-allow-overwrite"], "1");
      assert.equal(pubReq.headers["x-cache-control-max-age"], "3600");
      assert.equal(pubReq.headers["x-ttl-days"], "7");
      assert.deepEqual(new Uint8Array(pubReq.body), MP4_BYTES);

      const privateAdapter = vercelBlob({
        access: "private",
        token: "vercel_blob_rw_storepriv_secret2",
      });
      const privStored = await privateAdapter.put({
        key: "secret/clip.webm",
        data: WEBM_BYTES,
        mediaType: "video/webm",
        filename: "clip.webm",
        ttlDays: 2,
        signal,
      });

      assert.equal(privStored.key, "secret/clip.webm");
      assert.equal(privStored.visibility, "private");
      assert.equal(requests[1].headers["x-vercel-blob-access"], "private");
      assert.equal(requests[1].headers["x-ttl-days"], "2");
      assert.equal(requests[1].headers.authorization, "Bearer vercel_blob_rw_storepriv_secret2");
    }));

  test("prefers EVE_VIDEO_BLOB_READ_WRITE_TOKEN over unrelated BLOB_READ_WRITE_TOKEN when VERCEL_OIDC_TOKEN is absent, and uses OIDC when present", () =>
    withBlobEnv(async () => {
      process.env.VERCEL = "1";
      process.env.EVE_VIDEO_BLOB_STORE_ID = "store_video_only";
      process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_storevid_videosecret";
      process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_storeother_unrelated";

      const adapter = vercelBlob();
      const signal = new AbortController().signal;

      const stored = await adapter.put({
        key: "clip.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "clip.mp4",
        signal,
      });

      assert.equal(stored.key, "clip.mp4");
      assert.equal(requests[0].headers.authorization, "Bearer vercel_blob_rw_storevid_videosecret");

      const headerSeg = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payloadSeg = Buffer.from(
        JSON.stringify({ sub: "test-project", exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString("base64url");
      const validOidcJwt = `${headerSeg}.${payloadSeg}.signature`;
      process.env.VERCEL_OIDC_TOKEN = validOidcJwt;
      await adapter.put({
        key: "clip-oidc.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "clip-oidc.mp4",
        signal,
      });

      assert.equal(requests[1].headers.authorization, `Bearer ${validOidcJwt}`);
      assert.equal(requests[1].headers["x-vercel-blob-store-id"], "video_only");
    }));

  test("round-trips overlapping prefix and key segment across put, get, status errors, and delete", () =>
    withBlobEnv(async () => {
      const signal = new AbortController().signal;
      const adapter = vercelBlob({
        token: "vercel_blob_rw_storepref_secret",
        prefix: "videos",
      });

      const stored = await adapter.put({
        key: "videos/2026-11-26/clip.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "clip.mp4",
        signal,
      });

      assert.equal(stored.key, "videos/2026-11-26/clip.mp4");
      assert.equal(
        stored.url,
        "https://storepref.public.blob.vercel-storage.com/videos/videos/2026-11-26/clip.mp4",
      );

      const loaded = await adapter.get?.({ key: stored.key, signal });
      assert.notEqual(loaded, null);
      assert.equal(loaded?.key, "videos/2026-11-26/clip.mp4");
      assert.equal(loaded?.mediaType, "video/mp4");
      assert.equal(loaded?.bytes, MP4_BYTES.byteLength);
      assert.deepEqual(loaded?.data, MP4_BYTES);
      assert.deepEqual(reroutedOrigins, ["https://storepref.public.blob.vercel-storage.com"]);

      assert.equal(await adapter.get?.({ key: "does-not-exist.mp4", signal }), null);

      nextGetStatusOverride = 304;
      await assert.rejects(
        () => adapter.get!({ key: stored.key, signal }),
        /Vercel Blob returned 304 without a video stream/,
      );

      nextGetStatusOverride = 500;
      await assert.rejects(
        () => adapter.get!({ key: stored.key, signal }),
        /Failed to fetch blob: 500/,
      );

      await adapter.delete?.({ key: stored.key, signal });
      const deleteReq = requests[requests.length - 1];
      assert.equal(deleteReq.method, "POST");
      assert.equal(deleteReq.url, "/delete");
      assert.deepEqual(JSON.parse(deleteReq.body.toString("utf8")), {
        urls: ["videos/videos/2026-11-26/clip.mp4"],
      });
      assert.equal(await adapter.get?.({ key: stored.key, signal }), null);
    }));

  test("automatically switches to multipart above 5 MiB and honors explicit multipart: false", () =>
    withBlobEnv(async () => {
      const signal = new AbortController().signal;
      const payload = new Uint8Array(5 * 1024 * 1024 + 1);
      payload.set(MP4_BYTES, 0);

      const autoAdapter = vercelBlob({
        token: "vercel_blob_rw_storempu_secret",
        prefix: "large",
      });
      const storedMpu = await autoAdapter.put({
        key: "big.mp4",
        data: payload,
        mediaType: "video/mp4",
        filename: "big.mp4",
        signal,
      });

      assert.equal(storedMpu.key, "big.mp4");
      assert.equal(storedMpu.bytes, payload.byteLength);
      const mpuActions = requests
        .filter((r) => r.url.startsWith("/mpu?"))
        .map((r) => r.headers["x-mpu-action"]);
      assert.deepEqual(mpuActions, ["create", "upload", "complete"]);

      requests.length = 0;
      const singlePutAdapter = vercelBlob({
        token: "vercel_blob_rw_storempu_secret",
        prefix: "large",
        multipart: false,
      });
      await singlePutAdapter.put({
        key: "big-single.mp4",
        data: payload,
        mediaType: "video/mp4",
        filename: "big-single.mp4",
        signal,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "PUT");
      assert.ok(requests[0].url.startsWith("/?pathname=large%2Fbig-single.mp4"));
    }));
});
