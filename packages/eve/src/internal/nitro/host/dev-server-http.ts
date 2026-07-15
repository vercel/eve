import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { toErrorMessage } from "#shared/errors.js";

export function createPublicRequest(request: IncomingMessage, signal: AbortSignal): Request {
  const authority = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${authority}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    body: hasBody ? (Readable.toWeb(request) as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
    headers,
    method: request.method,
    signal,
  } as RequestInit & { duplex?: "half" });
}

export async function writeResponse(
  response: ServerResponse,
  webResponse: Response,
  signal: AbortSignal,
): Promise<void> {
  if (response.destroyed) {
    await webResponse.body?.cancel();
    return;
  }

  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;
  const getSetCookie = (
    webResponse.headers as Headers & {
      getSetCookie?: () => readonly string[];
    }
  ).getSetCookie;
  const setCookies = getSetCookie?.call(webResponse.headers) ?? [];
  webResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") {
      response.setHeader(name, value);
    }
  });
  if (setCookies.length > 0) {
    response.setHeader("set-cookie", [...setCookies]);
  }

  if (webResponse.body === null) {
    await endResponse(response);
    return;
  }

  const body = Readable.fromWeb(webResponse.body as import("node:stream/web").ReadableStream);
  const cancelBody = () => body.destroy(signal.reason as Error | undefined);
  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onClose = () => {
        if (!response.writableEnded) {
          reject(new Error("Development client disconnected."));
        }
      };
      body.once("error", reject);
      response.once("error", reject);
      response.once("close", onClose);
      response.once("finish", resolve);
      body.pipe(response);
    });
  } finally {
    signal.removeEventListener("abort", cancelBody);
    if (!body.destroyed && (signal.aborted || response.destroyed)) {
      body.destroy();
    }
  }
}

export function writeRequestError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    // The status line is already on the wire; ending now would frame the
    // truncated body as a complete response. Destroying the socket is the
    // only way to surface the failure to the client mid-stream.
    response.destroy();
    return;
  }
  response.statusCode = 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (!response.writableEnded && !response.destroyed) {
    response.end(JSON.stringify({ error: toErrorMessage(error) }));
  }
}

export function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  server.closeIdleConnections?.();
  return closed;
}

async function endResponse(response: ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    response.once("error", reject);
    response.end(resolve);
  });
}
