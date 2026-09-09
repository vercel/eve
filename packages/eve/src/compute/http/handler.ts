import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { ComputeError } from "#compute/errors.js";
import type { ComputeLimits } from "#compute/limits.js";
import { DEFAULT_COMPUTE_LIMITS } from "#compute/limits.js";
import type { SendRequest } from "#compute/protocol.js";
import {
  admitMessage,
  readCellEvents,
  readCellView,
  readMessageReceipt,
  readNamespaceView,
} from "#compute/storage/cells.js";
import type { ComputeStorage } from "#compute/storage/types.js";
import {
  assertExactKeys,
  assertRecord,
  assertVersionedValue,
  parseCounter,
} from "#compute/validation.js";
import type { ComputeAuthenticator, ComputePermission } from "#compute/http/auth.js";

const MAX_EVENT_PAGE_BYTES = 16 * 1024 * 1024;

export interface ComputeHttpHandlerOptions {
  authenticator: ComputeAuthenticator;
  limits?: ComputeLimits;
  storage: ComputeStorage;
}

function errorStatus(error: ComputeError): number {
  switch (error.code) {
    case "INVALID_INPUT":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "REVISION_CONFLICT":
    case "STALE_EXECUTION":
    case "CONCURRENT_MUTATION":
    case "MIGRATION_REQUIRED":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "QUOTA_EXCEEDED":
      return 429;
    case "DEPLOYMENT_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof ComputeError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: errorStatus(error) },
    );
  }
  const incidentId = randomUUID();
  console.error("Unexpected compute HTTP failure.", { incidentId, error });
  return Response.json(
    {
      error: {
        code: "INTERNAL",
        message: "Unexpected compute failure.",
        incidentId,
      },
    },
    { status: 500 },
  );
}

async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (request.body === null) {
    throw new ComputeError("INVALID_INPUT", "Request body is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ComputeError("PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ComputeError("INVALID_INPUT", "Request body is not valid JSON.");
  }
}

function parseSendRequest(value: unknown): SendRequest {
  assertRecord(value, "request");
  assertExactKeys(value, ["address", "message", "idempotencyKey"], "request");
  assertRecord(value.address, "request.address");
  assertExactKeys(value.address, ["definition", "key"], "request.address");
  assertVersionedValue(value.message, "request.message");
  if (typeof value.idempotencyKey !== "string") {
    throw new ComputeError("INVALID_INPUT", "request.idempotencyKey must be a string.");
  }
  if (typeof value.address.definition !== "string" || typeof value.address.key !== "string") {
    throw new ComputeError("INVALID_INPUT", "request.address is invalid.");
  }
  return {
    address: {
      definition: value.address.definition,
      key: value.address.key,
    },
    message: value.message,
    idempotencyKey: value.idempotencyKey,
  };
}

function decodePathSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ComputeError("INVALID_INPUT", `${label} is not valid URL encoding.`);
  }
}

function routeMatch(pathname: string):
  | {
      namespaceId: string;
      permission: ComputePermission;
      resourceId?: string;
      route: "namespace" | "send" | "cell" | "receipt" | "events";
    }
  | undefined {
  const prefix = "/compute/v1/namespaces/";
  if (!pathname.startsWith(prefix)) return undefined;
  const remainder = pathname.slice(prefix.length);
  const slash = remainder.indexOf("/");
  const namespaceId = decodePathSegment(
    slash === -1 ? remainder : remainder.slice(0, slash),
    "namespaceId",
  );
  const suffix = slash === -1 ? "/" : remainder.slice(slash);
  if (suffix === "/") return { namespaceId, permission: "read", route: "namespace" };
  if (suffix === "/cells:send") return { namespaceId, permission: "send", route: "send" };
  const cellEvents = /^\/cells\/([^/]+)\/events$/u.exec(suffix);
  if (cellEvents !== null) {
    return {
      namespaceId,
      permission: "read",
      resourceId: decodePathSegment(cellEvents[1]!, "cellId"),
      route: "events",
    };
  }
  const cell = /^\/cells\/([^/]+)$/u.exec(suffix);
  if (cell !== null) {
    return {
      namespaceId,
      permission: "read",
      resourceId: decodePathSegment(cell[1]!, "cellId"),
      route: "cell",
    };
  }
  const receipt = /^\/messages\/([^/]+)$/u.exec(suffix);
  if (receipt !== null) {
    return {
      namespaceId,
      permission: "read",
      resourceId: decodePathSegment(receipt[1]!, "messageId"),
      route: "receipt",
    };
  }
  return undefined;
}

export function createComputeHttpHandler(
  options: ComputeHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const limits = options.limits ?? DEFAULT_COMPUTE_LIMITS;
  return async (request) => {
    try {
      const url = new URL(request.url);
      const match = routeMatch(url.pathname);
      if (match === undefined) {
        throw new ComputeError("NOT_FOUND", "Compute route was not found.");
      }
      const principal = await options.authenticator.authenticate(
        request,
        match.namespaceId,
        match.permission,
      );
      if (match.route === "send") {
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const body = parseSendRequest(
          await readBoundedJson(request, limits.maxMessageBytes + 64 * 1024),
        );
        return Response.json(
          await admitMessage(options.storage, {
            limits,
            namespaceId: match.namespaceId,
            principalId: principal.principalId,
            request: body,
          }),
          { status: 202 },
        );
      }
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      if (match.route === "namespace") {
        return Response.json(await readNamespaceView(options.storage, match.namespaceId));
      }
      if (match.resourceId === undefined) {
        throw new ComputeError("INTERNAL", "Compute route resource is missing.");
      }
      if (match.route === "cell") {
        return Response.json(
          await readCellView(options.storage, match.namespaceId, match.resourceId),
        );
      }
      if (match.route === "receipt") {
        return Response.json(
          await readMessageReceipt(options.storage, match.namespaceId, match.resourceId),
        );
      }
      const follow = url.searchParams.get("follow");
      if (follow === "true") {
        throw new ComputeError(
          "DEPLOYMENT_UNAVAILABLE",
          "Following event streams is not available before milestone A5.",
        );
      }
      if (follow !== null && follow !== "false") {
        throw new ComputeError("INVALID_INPUT", "follow must be true or false.");
      }
      const after = parseCounter(url.searchParams.get("after") ?? "0", "after");
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      const events = await readCellEvents(
        options.storage,
        match.namespaceId,
        match.resourceId,
        after,
        limit,
      );
      let body = "";
      for (const event of events) {
        const line = `${JSON.stringify(event)}\n`;
        if (
          Buffer.byteLength(body, "utf8") + Buffer.byteLength(line, "utf8") >
          MAX_EVENT_PAGE_BYTES
        ) {
          break;
        }
        body += line;
      }
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
