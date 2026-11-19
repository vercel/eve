/**
 * In-memory Contentful Management and Upload APIs for unit tests.
 *
 * @packageDocumentation
 */
import { onTestFinished, vi } from "vitest";

import type { JsonObject, JsonValue } from "../../json";
import { isString, isCallable, isObject, isNumber } from "../../values";
import { API_HOST, UPLOAD_HOST } from "../model";
import type { Link, LocalizedFields, RawContentType, RawSys } from "../types";

/**
 * Builds a CMA link fixture with a selectable resource kind.
 *
 * @param id - Referenced resource ID.
 * @param linkType - Contentful link kind, defaulting to Entry.
 * @returns JSON-compatible Link system metadata.
 */
export const link = (id: string, linkType = "Entry") => ({
  sys: { id, linkType, type: "Link" as const },
});

/**
 * Builds a content type response matching the fields returned by the CMA.
 *
 * @param id - Content type ID.
 * @param fields - Field definitions used to validate writes in the fake API.
 * @param name - Display name, defaulting to the content type ID.
 * @returns A typed content type fixture.
 */
export const contentType = (
  id: string,
  fields: RawContentType["fields"],
  name = id
): RawContentType => ({ fields, name, sys: { id } });

/* A stored entry or asset. */
/**
 * Mutable stored entry or asset used by the in-memory CMA fixture.
 */
export interface CmaResource extends JsonObject {
  fields: LocalizedFields;
  metadata?: JsonObject;
  sys: RawSys;
}

/* A stored upload, as the Upload API returns it. */
/**
 * Stored binary-upload metadata exposed by the fixture Upload API.
 */
export interface CmaUpload extends JsonObject {
  sys: { expiresAt: string; id: string; space: Link; type: "Upload" };
}

type CmaCollection = "assets" | "content_types" | "entries" | "uploads";

/* One recorded request, parsed for assertions and failure predicates. */
/**
 * Parsed CMA or Upload API request recorded by the in-memory transport fixture.
 */
export interface CmaRequest {
  /* `published` or `process` for those sub-resources, otherwise null. */
  action: "process" | "published" | null;
  /* Parsed JSON for string bodies; binary bodies as sent. */
  body: JsonValue;
  collection: CmaCollection | null;
  headers: Headers;
  /* Addressed resource ID, or null for a collection request. */
  id: string | null;
  init: RequestInit;
  method: string;
  url: URL;
}

/* A status (JSON error body), a thrown error, or a custom response. */
/**
 * Injected failure expressed as an HTTP status, thrown error, or request-dependent response.
 */
export type CmaFailure =
  | Error
  | number
  | ((request: CmaRequest) => Response | Promise<Response>);

type Predicate = (request: CmaRequest) => boolean;
type Handler = (
  request: CmaRequest,
  proceed: () => Promise<Response>
) => Response | Promise<Response>;

interface CmaFakeOptions {
  defaultLocale?: string;
  assets?: CmaResource[];
  /* Content types by ID; a function can derive one from the requested ID. */
  contentTypes?:
    | RawContentType[]
    | ((id: string) => RawContentType | undefined);
  entries?: CmaResource[];
  /* When false, processing is accepted but waits for `process(id)`. */
  processImmediately?: boolean;
}

const CMA_PATH =
  /^\/spaces\/(?<spaceId>[^/]+)\/environments\/master\/(?<collection>entries|assets|content_types)(?:\/(?<id>[^/]+)(?:\/(?<action>published)|\/files\/(?<locale>[^/]+)\/(?<process>process))?)?$/u;
const UPLOAD_PATH =
  /^\/spaces\/(?<spaceId>[^/]+)\/uploads(?:\/(?<id>[^/]+))?$/u;

const parse = (input: URL | string, init: RequestInit = {}): CmaRequest => {
  const url = new URL(input);
  const cma = CMA_PATH.exec(url.pathname);
  const upload = UPLOAD_PATH.exec(url.pathname);
  let action: CmaRequest["action"] = null;
  if (cma?.[4]) {
    action = "published";
  } else if (cma?.[6]) {
    action = "process";
  }
  return {
    action,
    body: isString(init.body) ? JSON.parse(init.body) : init.body,
    // SAFETY: The regex restricts matched collections; unmatched paths are rejected by the fake dispatcher before store access.
    collection: (cma?.[2] ?? (upload ? "uploads" : null)) as CmaCollection,
    headers: new Headers(init.headers),
    id: cma?.[3] ?? upload?.[2] ?? null,
    init,
    method: init.method ?? "GET",
    url,
  };
};

const error = (status: number, id: string, message: string) =>
  Response.json({ message, sys: { id, type: "Error" } }, { status });

const project = (resource: CmaResource, select: string | null) => {
  if (!select) {
    return resource;
  }
  const projected: Record<string, JsonObject> = {};
  const source: JsonObject = resource;
  for (const selector of select.split(",")) {
    const [top, child] = selector.trim().split(".");
    const selected = source[top];
    if (!isObject(selected) || Array.isArray(selected)) {
      continue;
    }
    if (child === undefined) {
      projected[top] = selected;
    } else if (child in selected) {
      projected[top] = { ...projected[top], [child]: selected[child] };
    }
  }
  return projected;
};

const save = (request: CmaRequest, raw: CmaResource) => {
  // SAFETY: The fake receives JSON field payloads constructed by tested CMA operations; persisted responses are checked by each scenario.
  const { fields = {}, metadata } = (request.body ??
    {}) as Partial<CmaResource>;
  raw.fields = fields;
  if (metadata) {
    raw.metadata = metadata;
  }
  raw.sys.version = (raw.sys.version ?? 0) + 1;
  return Response.json(raw);
};

/**
 * Install an in-memory CMA as the global fetch for the current test.
 *
 * @example
 * ```ts
 * const cma = createCmaFake({
 *   contentTypes: [contentType("codeBlock", fields)],
 *   entries: [{ fields: {}, sys: { contentType: link("codeBlock", "ContentType"), id: "code", version: 1 } }],
 * });
 * cma.failWhen((request) => request.action === "published", 409);
 * ```
 *
 * @returns Stores, recorded requests, and controls for failures and processing.
 *
 * @remarks
 * Models GET by ID, `sys.id[in]` collection queries per collection with
 * `select`, entry creation by POST or by PUT with a reserved ID, saves and
 * publication bound to `X-Contentful-Version` (409 on mismatch), required-field
 * and processed-file checks on publication (422), asset processing, and the
 * Upload API. Resources are stored by reference, so a test can mutate one to
 * simulate a concurrent editor. Responses are serialized, so the code under
 * test never shares an object with the store. A request the fake does not
 * model fails the test instead of returning a guessed response.
 * @param options - Seed resources, content models, and automatic asset-processing behavior.
 */
export const createCmaFake = (options: CmaFakeOptions = {}) => {
  const entries = new Map(options.entries?.map((raw) => [raw.sys.id, raw]));
  const assets = new Map(options.assets?.map((raw) => [raw.sys.id, raw]));
  const uploads = new Map<string, CmaUpload>();
  const settings = { processImmediately: options.processImmediately ?? true };
  const interceptors: { handle: Handler; matches: Predicate; times: number }[] =
    [];
  const violations: string[] = [];
  let created = 0;

  const findContentType = (id: string) => {
    const { contentTypes = [] } = options;
    return isCallable(contentTypes)
      ? contentTypes(id)
      : contentTypes.find((type) => type.sys.id === id);
  };

  const violation = (message: string): never => {
    violations.push(message);
    throw new Error(`CMA fake: ${message}`);
  };

  /* Complete processing: drop the upload source and add the served file. */
  const processAsset = (assetId: string, locale = "en-US") => {
    const asset = assets.get(assetId);
    const file = asset?.fields.file?.[locale];
    if (!(asset && file && isObject(file))) {
      throw new Error(`CMA fake: asset ${assetId} has no ${locale} file.`);
    }
    // SAFETY: The object guard above admits the localized file object supplied by controlled asset fixtures.
    const {
      upload: _upload,
      uploadFrom: _uploadFrom,
      ...rest
    } = file as {
      fileName?: string;
      upload?: JsonValue;
      uploadFrom?: JsonValue;
    };
    asset.fields.file[locale] = {
      ...rest,
      details: { image: { height: 1, width: 1 }, size: 68 },
      url: `//images.ctfassets.net/${assetId}/${rest.fileName ?? "file"}`,
    };
    asset.sys.version = (asset.sys.version ?? 0) + 1;
  };

  const respondUpload = (request: CmaRequest) => {
    const { headers, init, method, url } = request;
    const space = UPLOAD_PATH.exec(url.pathname)?.[1];
    if (
      !space ||
      init.redirect !== "error" ||
      headers.get("content-type") !== "application/octet-stream" ||
      headers.get("authorization") !==
        `Bearer ${process.env.CONTENTFUL_MANAGEMENT_TOKEN}`
    ) {
      return violation(`malformed Upload API request ${method} ${url.href}`);
    }
    if (method === "POST" && request.id === null) {
      if (!(init.body instanceof Uint8Array)) {
        return violation("upload body is not binary");
      }
      const upload: CmaUpload = {
        sys: {
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          id: `upload-${uploads.size + 1}`,
          space: link(space, "Space"),
          type: "Upload",
        },
      };
      uploads.set(upload.sys.id, upload);
      return Response.json(upload, { status: 201 });
    }
    const upload = method === "GET" && uploads.get(request.id ?? "");
    return upload
      ? Response.json(upload)
      : error(404, "NotFound", "The upload could not be found.");
  };

  /* Field paths that block publication, as the CMA validates them. */
  const publicationErrors = (request: CmaRequest, raw: CmaResource) => {
    if (request.collection === "assets") {
      // SAFETY: raw.fields is already localized fixture data; Partial permits absent file fields in negative tests.
      const { file } = raw.fields as Partial<LocalizedFields>;
      // SAFETY: Asset fixtures store localized file objects; only the optional url is inspected to model processing status.
      const served = file?.["en-US"] as { url?: JsonValue } | undefined;
      return isString(served?.url) ? [] : [["fields", "file", "url"]];
    }
    const type = findContentType(raw.sys.contentType?.sys.id ?? "");
    return (type?.fields ?? [])
      .filter(
        (field) =>
          field.required && raw.fields[field.id]?.["en-US"] === undefined
      )
      .map((field) => ["fields", field.id]);
  };

  const publish = (request: CmaRequest, raw: CmaResource) => {
    const paths = publicationErrors(request, raw);
    if (paths.length > 0) {
      return Response.json(
        {
          details: {
            errors: paths.map((path) => ({ name: "required", path })),
          },
          message: "Validation error",
          sys: { id: "ValidationFailed", type: "Error" },
        },
        { status: 422 }
      );
    }
    raw.sys.publishedVersion = raw.sys.version;
    raw.sys.version = (raw.sys.version ?? 0) + 1;
    return Response.json(raw);
  };

  const create = (request: CmaRequest, store: Map<string, CmaResource>) => {
    // SAFETY: The fake receives JSON field payloads constructed by tested CMA operations; persisted responses are checked by each scenario.
    const { fields = {}, metadata } = (request.body ??
      {}) as Partial<CmaResource>;
    const contentTypeId = request.headers.get("x-contentful-content-type");
    if (request.collection === "entries" && !contentTypeId) {
      return error(422, "InvalidEntry", "Missing content type.");
    }
    if (request.id === null) {
      created += 1;
    }
    const resource: CmaResource = {
      fields,
      ...(metadata && { metadata }),
      sys: {
        ...(contentTypeId && {
          contentType: link(contentTypeId, "ContentType"),
        }),
        id: request.id ?? `created-${created - 1}`,
        version: 1,
      },
    };
    store.set(resource.sys.id, resource);
    return Response.json(resource, { status: 201 });
  };

  const respondCollection = (
    request: CmaRequest,
    store: Map<string, CmaResource>
  ) => {
    const { method, url } = request;
    if (method === "POST") {
      return create(request, store);
    }
    const ids = url.searchParams.get("sys.id[in]");
    if (method !== "GET" || ids === null) {
      return violation(`unmodeled collection query ${method} ${url.href}`);
    }
    const wanted = new Set(ids.split(","));
    const items = [...store.values()]
      .filter((resource) => wanted.has(resource.sys.id))
      .map((resource) => project(resource, url.searchParams.get("select")));
    return Response.json({ items, total: items.length });
  };

  const respondResource = (
    request: CmaRequest,
    store: Map<string, CmaResource>,
    id: string
  ) => {
    const { action, method, url } = request;
    const raw = store.get(id);
    const version = request.headers.get("x-contentful-version");
    if (method !== "GET" && method !== "PUT") {
      return violation(`unmodeled request ${method} ${url.href}`);
    }
    if (method === "PUT" && action === null && !raw && version === null) {
      return create(request, store);
    }
    if (!raw) {
      return error(404, "NotFound", "The resource could not be found.");
    }
    if (method === "GET") {
      return Response.json(raw);
    }
    if (version !== String(raw.sys.version)) {
      return error(409, "VersionMismatch", "Version mismatch");
    }
    if (action === "published") {
      return publish(request, raw);
    }
    if (action === null) {
      return save(request, raw);
    }
    if (settings.processImmediately) {
      processAsset(id, CMA_PATH.exec(url.pathname)?.[5]);
    }
    return new Response(null, { status: 204 });
  };

  /* The modeled API behavior, without interceptors. */
  const respond = (request: CmaRequest): Response | Promise<Response> => {
    const { collection, id, method, url } = request;
    if (url.origin === UPLOAD_HOST) {
      return respondUpload(request);
    }
    if (
      url.origin === API_HOST &&
      method === "GET" &&
      url.pathname.endsWith("/locales")
    ) {
      return Response.json({
        items: [{ code: options.defaultLocale ?? "en-US", default: true }],
      });
    }
    if (url.origin !== API_HOST || collection === null) {
      return violation(`unmodeled request ${method} ${url.href}`);
    }
    if (collection === "content_types") {
      const type = method === "GET" && id ? findContentType(id) : undefined;
      return type
        ? Response.json(type)
        : error(404, "NotFound", "The content type could not be found.");
    }
    const store = collection === "entries" ? entries : assets;
    return id === null
      ? respondCollection(request, store)
      : respondResource(request, store, id);
  };

  const fetch = vi.fn(
    async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
      init.signal?.throwIfAborted();
      const request = parse(input, init);
      const dispatch = (index: number): Promise<Response> => {
        const offset = interceptors
          .slice(index)
          .findIndex(
            (candidate) => candidate.times > 0 && candidate.matches(request)
          );
        if (offset === -1) {
          return Promise.resolve(respond(request));
        }
        const matched = interceptors[index + offset];
        matched.times -= 1;
        return Promise.resolve(
          matched.handle(request, () => dispatch(index + offset + 1))
        );
      };
      return await dispatch(0);
    }
  );
  vi.stubGlobal("fetch", fetch);
  onTestFinished(() => {
    if (violations.length > 0) {
      throw new Error(`CMA fake violations:\n${violations.join("\n")}`);
    }
  });

  const requests = () =>
    fetch.mock.calls.map(([url, init]) => parse(url, init));
  return {
    assets,
    entries,
    /**
     * Fail matching requests before they reach the store.
     *
     * @param times - How many matching requests fail; unlimited by default.
     * @param matches - Predicate selecting requests to intercept before store mutation.
     * @param failure - HTTP status, thrown error, or response-producing interceptor.
     */
    failWhen(
      matches: Predicate,
      failure: CmaFailure,
      times = Number.POSITIVE_INFINITY
    ) {
      interceptors.push({
        handle: (request) => {
          if (failure instanceof Error) {
            throw failure;
          }
          return isNumber(failure)
            ? error(failure, "Failure", `Injected ${failure}`)
            : failure(request);
        },
        matches,
        times,
      });
    },
    /* The installed fetch mock; `mockClear()` also clears `requests()`. */
    fetch,
    /* Wrap matching requests; call `proceed()` for the modeled response. */
    intercept(
      matches: Predicate,
      handle: Handler,
      times = Number.POSITIVE_INFINITY
    ) {
      interceptors.push({ handle, matches, times });
    },
    /* Finish processing an asset left pending by `processImmediately: false`. */
    process: processAsset,
    requests,
    settings,
    uploads,
    /* Every recorded request that is not a GET, in order. */
    writes: () => requests().filter((request) => request.method !== "GET"),
  };
};

/**
 * In-memory Contentful fixture exposing stores, request history, and controllable failures or asset processing.
 */
export type CmaFake = ReturnType<typeof createCmaFake>;
