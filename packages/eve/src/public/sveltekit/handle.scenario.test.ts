import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { createEveHandle } from "./handle.js";

const servers: Server[] = [];

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function forward(origin: string, request: Request): Promise<Response> {
  return createEveHandle({ origin })({
    event: { request, url: new URL(request.url) },
    resolve: async () => {
      throw new Error("eve routes must not reach SvelteKit's resolver");
    },
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("createEveHandle HTTP transport", () => {
  it.each([false, true])(
    "streams chunked uploads, strips hop headers (extra headers: %s), and preserves redirects",
    async (extraHeaders) => {
      const firstChunk = Promise.withResolvers<void>();
      const received = Promise.withResolvers<{
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
      }>();
      const origin = await serve((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          firstChunk.resolve();
        });
        request.on("end", () => {
          received.resolve({ body, headers: request.headers });
          response.writeHead(307, { location: "/login" });
          response.end("redirect");
        });
      });
      const upload = new TransformStream<Uint8Array, Uint8Array>();
      const writer = upload.writable.getWriter();
      const responsePromise = forward(
        origin,
        new Request("https://app.example.com/eve/v1/session?mode=stream", {
          method: "POST",
          headers: {
            host: "app.example.com",
            "transfer-encoding": "chunked",
            ...(extraHeaders
              ? {
                  connection: "keep-alive, X-Private-Hop, x-second-hop",
                  "keep-alive": "timeout=5",
                  "proxy-authenticate": "Basic",
                  "proxy-authorization": "Basic local-proxy",
                  "proxy-connection": "keep-alive",
                  te: "trailers",
                  trailer: "x-checksum",
                  upgrade: "websocket",
                  "x-private-hop": "local",
                  "x-second-hop": "local",
                }
              : {}),
            authorization: "Bearer session",
            cookie: "session=alice",
            "content-type": "application/json",
          },
          body: upload.readable,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      // Observe rejections immediately, even if fetch rejects before accepting the upload.
      void responsePromise.catch((error: unknown) => firstChunk.reject(error));
      await writer.write(new TextEncoder().encode('{"message":'));
      await firstChunk.promise;
      await writer.write(new TextEncoder().encode('"hello"}'));
      await writer.close();
      const response = await responsePromise;
      const { body, headers } = await received.promise;

      expect(body).toBe('{"message":"hello"}');
      expect(headers.host).toBe(new URL(origin).host);
      expect(headers.authorization).toBe("Bearer session");
      expect(headers.cookie).toBe("session=alice");
      expect(headers["content-type"]).toBe("application/json");
      // fetch supplies its own Connection and Transfer-Encoding for the new hop.
      for (const name of [
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "upgrade",
        "x-private-hop",
        "x-second-hop",
      ]) {
        expect(headers[name], name).toBeUndefined();
      }
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/login");
      expect(await response.text()).toBe("redirect");
    },
    10_000,
  );

  it("forwards decoded responses without stale framing while preserving status and separate cookies", async () => {
    const text = "hello from eve ".repeat(100);
    const compressed = gzipSync(text);
    const cookies = [
      "session=alice; Path=/; HttpOnly",
      "preference=compact; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
    ];
    const origin = await serve((_request, response) => {
      response.writeHead(202, "Accepted by eve", {
        "content-encoding": "gzip",
        "content-length": compressed.length,
        "content-type": "text/plain",
        connection: "keep-alive, X-Upstream-Hop",
        "keep-alive": "timeout=5",
        "x-upstream-hop": "local",
        "set-cookie": cookies,
      });
      response.end(compressed);
    });

    const response = await forward(origin, new Request("https://app.example.com/eve/v1/session"));

    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted by eve");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.getSetCookie()).toEqual(cookies);
    for (const name of [
      "content-encoding",
      "content-length",
      "connection",
      "keep-alive",
      "x-upstream-hop",
    ]) {
      expect(response.headers.get(name), name).toBeNull();
    }
    expect(await response.text()).toBe(text);
  }, 10_000);

  it.each(["abort", "cancel"] as const)(
    "streams before completion and closes the upstream on %s",
    async (action) => {
      const closed = Promise.withResolvers<void>();
      const origin = await serve((_request, response) => {
        response.on("close", () => closed.resolve());
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: hello\n\n");
      });
      const controller = new AbortController();
      const response = await forward(
        origin,
        new Request("https://app.example.com/eve/v1/session/alice/stream", {
          signal: controller.signal,
        }),
      );
      expect(response.headers.get("transfer-encoding")).toBeNull();
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("data: hello\n\n");
      expect(first.done).toBe(false);

      if (action === "abort") {
        controller.abort();
        await expect(reader.read()).rejects.toThrow();
      } else {
        await reader.cancel();
      }
      await closed.promise;
    },
    10_000,
  );
});
