import { get } from "@vercel/blob";
import { z } from "zod";
import { getAuthSession } from "@db/services/auth/session";
import { readReadyBrowserImageArtifact } from "@db/services/browser-images";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { env } from "@shared/environment";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/artifacts/[artifactId]">
) {
  const session = await getAuthSession(request.headers);
  const parsedId = z.uuid().safeParse((await context.params).artifactId);
  if (!session || !parsedId.success) return notFound();

  const scope = accessScopeForUser(`better-auth:${session.user.id}`);
  const opened = await openArtifact(scope, parsedId.data, {
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    signal: request.signal,
  });
  if (!opened) return notFound();

  const headers = privateImageHeaders();
  headers.set("etag", opened.result.blob.etag);
  if (opened.result.statusCode === 304) {
    return new Response(null, { headers, status: 304 });
  }

  headers.set("content-length", String(opened.artifact.byteSize));
  headers.set("content-type", opened.artifact.mediaType);
  headers.set(
    "content-disposition",
    contentDisposition(opened.artifact.filename)
  );
  return new Response(opened.result.stream, { headers, status: 200 });
}

async function openArtifact(
  scope: ReturnType<typeof accessScopeForUser>,
  artifactId: string,
  options: { readonly ifNoneMatch?: string; readonly signal?: AbortSignal }
) {
  const artifact = await readReadyBrowserImageArtifact(scope, artifactId);
  const byteSize = artifact?.byteSize;
  const filename = artifact?.filename;
  const mediaType = artifact?.mediaType;
  if (!artifact || !byteSize || !filename || !mediaType) return undefined;
  if (!env.BLOB_STORE_ID && !env.BLOB_READ_WRITE_TOKEN) return undefined;
  const result = await get(artifact.storagePathname, {
    access: "private",
    abortSignal: options.signal,
    ifNoneMatch: options.ifNoneMatch,
  });
  if (!result) return undefined;
  if (
    result.statusCode === 200 &&
    (result.blob.size !== byteSize || result.blob.contentType !== mediaType)
  )
    return undefined;
  return { artifact: { ...artifact, byteSize, filename, mediaType }, result };
}

function notFound() {
  return new Response("Not found", {
    headers: privateImageHeaders(),
    status: 404,
  });
}

function privateImageHeaders() {
  return new Headers({
    "cache-control": "private, max-age=3600",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
