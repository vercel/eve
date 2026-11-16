import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { testState, installTestState } from "#lib/testing/state";

import type { JsonValue } from "../../json";
import { isObject } from "../../values";
import { configurationKey } from "../config";
import { UPLOAD_HOST } from "../model";
import { contentType, createCmaFake, link } from "../testing/cma";
import type { CmaFake, CmaRequest, CmaResource } from "../testing/cma";
import type { RawContentType } from "../types";
import { updateContentfulFields } from "../update";
import { createContentfulEntryWithAssets } from "./creation-state";
import type { ReadAssetFile } from "./files";
import { assetRuntime } from "./workflow";

const UNAVAILABLE_UPLOAD = /expired|unavailable/u;
const CREATIONS = "contentful.asset-creations";

const mocks = vi.hoisted(() => ({ delay: vi.fn() }));

const assetLink = (id: string) => link(id, "Asset");
const input = {
  assets: [
    {
      contentType: "image/png",
      fileName: "headshot.png",
      key: "headshot",
      sourceUrl: "https://avatars.slack-edge.com/headshot.png",
      title: "Example headshot",
    },
  ],
  contentTypeId: "author",
  fields: [
    { fieldId: "name", value: "Example" },
    { fieldId: "image", value: { newAsset: "headshot" } },
  ],
  resumeFrom: null,
  space: "docs",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64"
);
const fileAsset = {
  contentType: "image/png",
  fileName: "headshot.png",
  key: "headshot",
  sourcePath: "/workspace/.eve/attachments/headshot.png",
  title: "Example headshot",
};
const fileInput = { ...input, assets: [fileAsset] };

const modelFields = (id: string): RawContentType["fields"] => [
  { id: "name", name: "Name", required: true, type: "Symbol" },
  {
    id: "image",
    linkType: "Asset",
    name: "Image",
    required: true,
    type: "Link",
  },
  {
    id: "gallery",
    items: { linkType: "Asset", type: "Link" },
    name: "Gallery",
    type: "Array",
  },
  { id: "author", linkType: "Entry", name: "Author", type: "Link" },
  { id: "body", name: "Body", type: "RichText" },
  {
    id: "main",
    name: "Main",
    required: id === "guide",
    type: "RichText",
    validations: [{ enabledMarks: ["bold"] }],
  },
  { id: "content", name: "Content", type: "RichText" },
  { id: "description", name: "Description", type: "RichText" },
];
const cma = (seed: { assets?: CmaResource[]; entries?: CmaResource[] } = {}) =>
  createCmaFake({
    contentTypes: (id) => contentType(id, modelFields(id)),
    ...seed,
  });
const publishedAsset = (id: string): CmaResource => ({
  fields: { file: { "en-US": { url: `//images.ctfassets.net/${id}` } } },
  sys: { id, publishedVersion: 2, version: 3 },
});
const resourcePath = (request: CmaRequest) =>
  request.url.pathname.split("/").slice(5).join("/");
const isAssetCreate = (request: CmaRequest) =>
  request.method === "PUT" &&
  request.collection === "assets" &&
  request.action === null;
const isEntryCreate = (request: CmaRequest) =>
  request.method === "PUT" &&
  request.collection === "entries" &&
  request.action === null;
/* Let the CMA apply the proceed matching write, then lose its response. */
const loseResponse = (
  f: CmaFake,
  matches: (request: CmaRequest) => boolean,
  message = "Connection lost after server accepted the write"
) => {
  f.intercept(
    matches,
    async (_request, proceed) => {
      await proceed();
      throw new Error(message);
    },
    1
  );
};
/* Let the CMA apply one matching write, then return its response with altered sys metadata. */
const rewriteSys = (
  f: CmaFake,
  matches: (request: CmaRequest) => boolean,
  change: (sys: CmaResource["sys"]) => CmaResource["sys"]
) => {
  f.intercept(
    matches,
    async (_request, proceed) => {
      const response = await proceed();
      // SAFETY: The fake serializes stored CMA resources; only sys is rewritten.
      const body = (await response.json()) as CmaResource;
      return Response.json(
        { ...body, sys: change(body.sys) },
        { status: response.status }
      );
    },
    1
  );
};
const isAssetPublish = (request: CmaRequest) =>
  request.collection === "assets" && request.action === "published";
const isEntryPublish = (request: CmaRequest) =>
  request.collection === "entries" && request.action === "published";
const bumpVersion = (resource: CmaResource | undefined) => {
  if (!resource) {
    throw new Error("Missing resource");
  }
  resource.sys.version = (resource.sys.version ?? 0) + 1;
};
const containsBytes = <T>(value: T): boolean =>
  ArrayBuffer.isView(value) ||
  (isObject(value) &&
    value !== null &&
    Object.values(value).some(containsBytes));

const create = async (
  value: JsonValue = input,
  callId = "create-call",
  signal?: AbortSignal,
  readFile?: ReadAssetFile
) => {
  const result = await createContentfulEntryWithAssets(
    value,
    "session",
    callId,
    signal,
    readFile
  );
  if (!("recoveryId" in result)) {
    throw new Error("Expected an asset-backed result");
  }
  return result;
};
beforeEach(() => {
  vi.stubEnv("CONTENTFUL_MANAGEMENT_TOKEN", "test-contentful-token");
  testState.reset();
  mocks.delay.mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.useRealTimers();
});

const pageInput = {
  assets: null,
  contentTypeId: "guide",
  fields: [],
  resumeFrom: null,
  space: "docs",
};
const pageBody = {
  content: [
    {
      content: [{ data: {}, marks: [], nodeType: "text", value: "Draft body" }],
      data: {},
      nodeType: "paragraph",
    },
  ],
  data: {},
  nodeType: "document",
};

describe("page draft creation", () => {
  it.each([
    ["docs", "guide"],
    ["docs", "topic"],
    ["site", "blogPost"],
    ["site", "newsItem"],
    ["site", "page"],
    ["site", "blogCategory"],
  ])(
    "creates an empty %s/%s draft without required fields or publication",
    async (space, contentTypeId) => {
      const f = cma();
      const result = await create({ ...pageInput, contentTypeId, space });
      expect(result).toMatchObject({
        assets: [],
        complete: true,
        entry: { stage: "created", version: 1 },
        error: null,
        publicationTarget: "draft",
      });
      expect(result.entry.contentfulUrl).toContain(
        `/entries/${result.entry.entryId}`
      );
      const writes = f.writes();
      expect(writes).toHaveLength(1);
      expect(resourcePath(writes[0])).toBe(`entries/${result.entry.entryId}`);
      expect(writes[0].method).toBe("PUT");
      expect(f.entries.get(result.entry.entryId)).toMatchObject({
        fields: {},
        sys: { version: 1 },
      });
      expect(
        f.entries.get(result.entry.entryId)?.sys.publishedVersion
      ).toBeUndefined();
    }
  );

  it("accepts the initial protected body for docs/guide/main", async () => {
    const f = cma();
    const result = await create({
      ...pageInput,
      contentTypeId: "guide",
      fields: [{ fieldId: "main", value: pageBody }],
      space: "docs",
    });
    expect(result.complete).toBe(true);
    expect(f.entries.get(result.entry.entryId)?.fields).toEqual({
      main: { "en-US": pageBody },
    });
    expect(f.writes()).toHaveLength(1);
  });

  it("saves supplied metadata without filling missing required fields", async () => {
    const f = cma();
    const result = await create({
      ...pageInput,
      fields: [{ fieldId: "name", value: "Work in progress" }],
    });
    expect(result.complete).toBe(true);
    expect(f.entries.get(result.entry.entryId)?.fields).toEqual({
      name: { "en-US": "Work in progress" },
    });
  });

  it.each([true, false])(
    "keeps later body sets and unsets blocked (initial body: %s)",
    async (withBody) => {
      const f = cma();
      const result = await create({
        ...pageInput,
        fields: withBody ? [{ fieldId: "main", value: pageBody }] : [],
      });
      f.fetch.mockClear();
      for await (const operation of ["set", "unset"] as const) {
        await expect(
          updateContentfulFields({
            entries: [
              {
                changes: [
                  {
                    fieldId: "main",
                    operation,
                    value: operation === "set" ? pageBody : null,
                  },
                ],
                entryId: result.entry.entryId,
                expectedVersion: 1,
              },
            ],
            space: "docs",
          })
        ).rejects.toThrow("RichText writes are not supported");
      }
      expect(f.writes()).toHaveLength(0);
    }
  );

  it.each([
    { fieldId: "main", value: "not a document" },
    {
      fieldId: "main",
      value: {
        ...pageBody,
        content: [{ content: [], data: {}, nodeType: "unknown" }],
      },
    },
    {
      fieldId: "main",
      value: {
        ...pageBody,
        content: [
          {
            content: [],
            data: { target: link("missing") },
            nodeType: "embedded-entry-block",
          },
        ],
      },
    },
    {
      fieldId: "main",
      value: {
        ...pageBody,
        content: [
          {
            content: [],
            data: { target: { newAsset: "headshot" } },
            nodeType: "embedded-asset-block",
          },
        ],
      },
    },
    { fieldId: "name", value: 42 },
    { fieldId: "unknown", value: "unknown" },
  ])(
    "rejects invalid supplied page content before asset writes: %j",
    async (change) => {
      const f = cma();
      await expect(
        create({
          ...input,
          contentTypeId: "guide",
          fields: [...input.fields, change],
        })
      ).rejects.toThrow();
      expect(f.writes()).toHaveLength(0);
    }
  );

  it("rejects disabled formatting in a page body", async () => {
    const f = cma();
    const value = structuredClone(pageBody);
    Object.assign(value.content[0].content[0], { marks: [{ type: "italic" }] });
    await expect(
      create({ ...pageInput, fields: [{ fieldId: "main", value }] })
    ).rejects.toThrow("disabled");
    expect(f.writes()).toHaveLength(0);
  });

  it.each([false, true])(
    "requires published embedded references (published: %s)",
    async (published) => {
      const f = cma({
        entries: [
          {
            fields: {},
            sys: {
              contentType: link("callout", "ContentType"),
              id: "component",
              version: 2,
              ...(published && { publishedVersion: 1 }),
            },
          },
        ],
      });
      const value = {
        ...pageBody,
        content: [
          {
            content: [],
            data: { target: link("component") },
            nodeType: "embedded-entry-block",
          },
        ],
      };
      const pending = create({
        ...pageInput,
        fields: [{ fieldId: "main", value }],
      });
      if (published) {
        const completed1 = await pending;
        expect(completed1.complete).toBe(true);
        expect(f.writes()).toHaveLength(1);
      } else {
        await expect(pending).rejects.toThrow();
        expect(f.writes()).toHaveLength(0);
      }
    }
  );

  it("publishes new assets but leaves the page unpublished", async () => {
    const f = cma();
    const result = await create(
      { ...fileInput, contentTypeId: "guide" },
      "page-image",
      undefined,
      vi.fn().mockResolvedValue(png)
    );
    expect(result).toMatchObject({
      assets: [{ stage: "published" }],
      complete: true,
      entry: { stage: "created", version: 1 },
      publicationTarget: "draft",
    });
    expect(
      f.entries.get(result.entry.entryId)?.sys.publishedVersion
    ).toBeUndefined();
    expect(
      f
        .writes()
        .filter((request) => request.collection === "entries")
        .map((request) => request.url.pathname)
    ).toEqual([
      `/spaces/sample-docs/environments/master/entries/${result.entry.entryId}`,
    ]);
  });

  it("resumes unfinished page assets and stops at draft creation", async () => {
    const f = cma();
    f.settings.processImmediately = false;
    const value = { ...input, contentTypeId: "guide" };
    const first = await create(value);
    expect(first).toMatchObject({
      assets: [{ stage: "processing" }],
      complete: false,
      entry: { stage: "notAttempted" },
      publicationTarget: "draft",
    });
    f.process(first.assets[0].assetId);
    f.fetch.mockClear();
    const result = await create(
      { ...value, resumeFrom: first.recoveryId },
      "resume"
    );
    expect(result).toMatchObject({
      assets: [{ stage: "published" }],
      complete: true,
      entry: { stage: "created", version: 1 },
      publicationTarget: "draft",
    });
    expect([f.assets.size, f.entries.size]).toEqual([1, 1]);
    expect(
      f
        .writes()
        .some(
          (request) =>
            request.collection === "entries" && request.action === "published"
        )
    ).toBe(false);
  });

  it("rejects a saved page target that would publish during recovery", async () => {
    const f = cma();
    const first = await create(pageInput);
    const plans = z
      .record(z.string(), z.record(z.string(), z.json()))
      .parse(testState.get(CREATIONS));
    testState.set(CREATIONS, {
      [first.recoveryId]: {
        ...plans[first.recoveryId],
        publicationTarget: "published",
      },
    });
    f.fetch.mockClear();
    const recovered = await create(
      { ...pageInput, resumeFrom: first.recoveryId },
      "resume"
    );
    expect(recovered.complete).toBe(false);
    expect(recovered.error).toContain("publication target");
    expect(f.writes()).toHaveLength(0);
  });

  it("replays and resumes a confirmed page without additional writes", async () => {
    const f = cma();
    const result = await create(pageInput);
    f.fetch.mockClear();
    expect(await create(pageInput)).toEqual(result);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      await create({ ...pageInput, resumeFrom: result.recoveryId }, "resume")
    ).toEqual(result);
    expect(f.writes()).toHaveLength(0);
  });

  it.each([false, true])(
    "recovers an interrupted page at its reserved ID (CMA saved: %s)",
    async (saved) => {
      const f = cma();
      if (saved) {
        loseResponse(f, isEntryCreate, "Connection interrupted");
      } else {
        f.failWhen(isEntryCreate, new Error("Connection interrupted"), 1);
      }
      const first = await create(pageInput);
      expect(first).toMatchObject({
        complete: false,
        entry: { stage: "creating", version: null },
        publicationTarget: "draft",
      });
      f.fetch.mockClear();
      const replay = await create(pageInput);
      expect(replay).toEqual(first);
      expect(f.fetch).not.toHaveBeenCalled();
      const recovered = await create(
        { ...pageInput, resumeFrom: first.recoveryId },
        "resume"
      );
      expect(recovered).toMatchObject({
        complete: true,
        entry: { entryId: first.entry.entryId, stage: "created", version: 1 },
      });
      expect(f.entries.size).toBe(1);
      expect(f.writes()).toHaveLength(saved ? 0 : 1);
      expect(f.writes().some((request) => request.action === "published")).toBe(
        false
      );
    }
  );

  it("rejects changed recovery inputs and externally edited pages", async () => {
    const f = cma();
    const first = await create(pageInput);
    f.fetch.mockClear();
    await expect(
      create(
        {
          ...pageInput,
          fields: [{ fieldId: "name", value: "Different" }],
          resumeFrom: first.recoveryId,
        },
        "resume"
      )
    ).rejects.toThrow("inputs differ");
    bumpVersion(f.entries.get(first.entry.entryId));
    const recovered = await create(
      { ...pageInput, resumeFrom: first.recoveryId },
      "resume"
    );
    expect(recovered.complete).toBe(false);
    expect(recovered.error).toContain("changed outside");
    expect(f.writes()).toHaveLength(0);
  });
});

describe("creating entries with binary attachments", () => {
  it.each(["docs", "site"])(
    "uploads original bytes before creating an asset in %s",
    async (space) => {
      const f = cma();
      const readFile = vi.fn().mockResolvedValue(png);
      const result = await create(
        { ...fileInput, space },
        "binary",
        undefined,
        readFile
      );
      expect(result.complete).toBe(true);
      expect(readFile).toHaveBeenCalledExactlyOnceWith(fileAsset.sourcePath);
      const [upload, asset] = f.writes();
      expect(upload.url.pathname).toBe(
        `/spaces/${space === "docs" ? "sample-docs" : "sample-site"}/uploads`
      );
      expect(upload.body).toEqual(png);
      expect(asset.body).toMatchObject({
        fields: {
          file: {
            "en-US": {
              contentType: "image/png",
              fileName: "headshot.png",
              uploadFrom: {
                sys: { id: "upload-1", linkType: "Upload", type: "Link" },
              },
            },
          },
        },
      });
      expect(result.assets[0].upload).toMatchObject({
        id: "upload-1",
        status: "uploaded",
      });
      const saved = testState.get(CREATIONS);
      expect(JSON.stringify(saved)).toContain('"sha256"');
      expect(containsBytes(saved)).toBe(false);
      expect(f.writes()).toHaveLength(6);
    }
  );

  it("supports URL and file sources in the same operation", async () => {
    const f = cma();
    const result = await create(
      {
        ...input,
        assets: [...input.assets, { ...fileAsset, key: "screenshot" }],
        fields: [
          ...input.fields,
          { fieldId: "gallery", value: [{ newAsset: "screenshot" }] },
        ],
      },
      "mixed",
      undefined,
      async () => await png
    );
    expect(result.complete).toBe(true);
    expect(f.uploads.size).toBe(1);
    expect(result.assets.map((asset) => asset.stage)).toEqual([
      "published",
      "published",
    ]);
  });

  it.each([
    { ...fileAsset, sourceUrl: input.assets[0].sourceUrl },
    { ...fileAsset, sourcePath: "/etc/passwd" },
    { ...fileAsset, sourcePath: "/workspace/.eve/attachments/../secret.png" },
    { ...fileAsset, sourcePath: "/workspace/.eve/attachments/./image.png" },
    { ...fileAsset, sourcePath: "data:image/png;base64,abc" },
  ])("rejects invalid or ambiguous sources before reads: %j", async (asset) => {
    const f = cma();
    const readFile = vi.fn();
    await expect(
      create({ ...input, assets: [asset] }, "invalid", undefined, readFile)
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("checks entry fields before touching attachments", async () => {
    const f = cma();
    const readFile = vi.fn();
    await expect(
      create(
        {
          ...fileInput,
          contentTypeId: "guide",
          fields: [...fileInput.fields, { fieldId: "main", value: "invalid" }],
        },
        "invalid",
        undefined,
        readFile
      )
    ).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(f.writes()).toHaveLength(0);
  });

  it.each([
    [Buffer.alloc(0), "non-empty"],
    [Buffer.from("not an image"), "must match contentType"],
    [Buffer.alloc(20 * 1024 * 1024 + 1), "at most 20 MiB"],
  ])(
    "rejects invalid file content before any writes (%#)",
    async (bytes, message) => {
      const f = cma();
      const result = await create(
        fileInput,
        "invalid",
        undefined,
        async () => await bytes
      );
      expect(result.complete).toBe(false);
      expect(result.error).toContain(message);
      expect(f.writes()).toHaveLength(0);
    }
  );

  it("rejects a MIME mismatch before any writes", async () => {
    const f = cma();
    const result = await create(
      { ...fileInput, assets: [{ ...fileAsset, contentType: "image/jpeg" }] },
      "mime",
      undefined,
      async () => await png
    );
    expect(result.error).toContain("contentType");
    expect(f.writes()).toHaveLength(0);
  });

  it("validates all attachments before uploading and pins already checked bytes", async () => {
    const f = cma();
    const batch = {
      ...fileInput,
      assets: [
        fileAsset,
        {
          ...fileAsset,
          key: "other",
          sourcePath: "/workspace/.eve/attachments/other.png",
        },
      ],
      fields: [
        ...input.fields,
        { fieldId: "gallery", value: [{ newAsset: "other" }] },
      ],
    };
    const reader = vi
      .fn()
      .mockResolvedValueOnce(png)
      .mockRejectedValueOnce(new Error("File missing"));
    const result = await create(batch, "batch", undefined, reader);
    expect(result.error).toContain("File missing");
    expect(f.writes()).toHaveLength(0);
    const changed = Buffer.concat([png, Buffer.from("changed")]);
    const resumed = await create(
      { ...batch, resumeFrom: result.recoveryId },
      "resume",
      undefined,
      async () => await changed
    );
    expect(resumed.error).toContain("changed since");
    expect(f.writes()).toHaveLength(0);
  });

  it("reuses a confirmed upload after asset creation fails, even if the attachment is gone", async () => {
    const f = cma();
    f.failWhen(isAssetCreate, 503, 1);
    const result = await create(
      fileInput,
      "binary",
      undefined,
      async () => await png
    );
    expect(result.assets[0].upload?.id).toBe("upload-1");
    f.fetch.mockClear();
    const reader = vi.fn().mockRejectedValue(new Error("Attachment gone"));
    const resumed = await create(
      { ...fileInput, resumeFrom: result.recoveryId },
      "resume",
      undefined,
      reader
    );
    expect(resumed.complete).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(f.writes().some((request) => request.method === "POST")).toBe(false);
    expect(resumed.assets[0].assetId).toBe(result.assets[0].assetId);
  });

  it("does not repeat an uncertain binary POST on replay or explicit recovery", async () => {
    const f = cma();
    loseResponse(
      f,
      (request) => request.method === "POST",
      "Upload response lost"
    );
    const result = await create(
      fileInput,
      "binary",
      undefined,
      async () => await png
    );
    expect(result.assets[0].stage).toBe("uploading");
    expect(f.uploads.size).toBe(1);
    f.fetch.mockClear();
    const reader = vi.fn();
    expect(await create(fileInput, "binary", undefined, reader)).toEqual(
      result
    );
    expect(f.fetch).not.toHaveBeenCalled();
    const resumed = await create(
      { ...fileInput, resumeFrom: result.recoveryId },
      "resume",
      undefined,
      reader
    );
    expect(resumed.error).toContain("uncertain");
    expect(reader).not.toHaveBeenCalled();
    expect(f.writes()).toHaveLength(0);
  });

  it.each(["expired", "missing"])(
    "stops recovery for an %s upload without replacing it",
    async (reason) => {
      const f = cma();
      f.failWhen(isAssetCreate, 503, 1);
      const result = await create(
        fileInput,
        "binary",
        undefined,
        async () => await png
      );
      f.fetch.mockClear();
      if (reason === "missing") {
        f.uploads.clear();
      } else {
        const expiresAt = result.assets[0].upload?.expiresAt;
        vi.setSystemTime(Date.parse(expiresAt ?? "") + 1);
      }
      const resumed = await create(
        { ...fileInput, resumeFrom: result.recoveryId },
        "resume"
      );
      expect(resumed.error).toMatch(UNAVAILABLE_UPLOAD);
      expect(f.writes()).toHaveLength(0);
    }
  );

  it("recovers a published image without its attachment or temporary upload", async () => {
    const f = cma();
    const result = await create(
      fileInput,
      "binary",
      undefined,
      async () => await png
    );
    f.uploads.clear();
    f.fetch.mockClear();
    const resumed = await create(
      { ...fileInput, resumeFrom: result.recoveryId },
      "resume"
    );
    expect(resumed.complete).toBe(true);
    expect(f.writes()).toHaveLength(0);
    expect(
      f.requests().some((request) => request.url.origin === UPLOAD_HOST)
    ).toBe(false);
  });

  it("resumes a processed image without its attachment or temporary upload", async () => {
    const f = cma();
    f.failWhen(isAssetPublish, 503, 1);
    const result = await create(
      fileInput,
      "binary",
      undefined,
      async () => await png
    );
    expect(result).toMatchObject({
      assets: [{ stage: "publishing", upload: { status: "uploaded" } }],
      complete: false,
      entry: { stage: "notAttempted" },
    });
    f.uploads.clear();
    f.fetch.mockClear();
    const reader = vi.fn().mockRejectedValue(new Error("Attachment gone"));
    const resumed = await create(
      { ...fileInput, resumeFrom: result.recoveryId },
      "resume",
      undefined,
      reader
    );
    expect(resumed).toMatchObject({
      assets: [{ assetId: result.assets[0].assetId, stage: "published" }],
      complete: true,
      error: null,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(
      f.requests().some((request) => request.url.origin === UPLOAD_HOST)
    ).toBe(false);
    expect(f.writes().filter(isAssetCreate)).toHaveLength(0);
    expect(f.assets.size).toBe(1);
  });

  it("rejects a changed Upload link before processing", async () => {
    const f = cma();
    f.failWhen((request) => request.action === "process", 503, 1);
    const result = await create(
      fileInput,
      "binary",
      undefined,
      async () => await png
    );
    const asset = f.assets.get(result.assets[0].assetId);
    if (!asset) {
      throw new Error("Missing asset");
    }
    asset.fields.file["en-US"] = {
      contentType: "image/png",
      fileName: "headshot.png",
      uploadFrom: link("different-upload", "Upload"),
    };
    f.fetch.mockClear();
    const resumed = await create(
      { ...fileInput, resumeFrom: result.recoveryId },
      "resume"
    );
    expect(resumed.error).toContain("file source");
    expect(f.writes()).toHaveLength(0);
  });
});

describe("creating entries with assets", () => {
  it.each(["docs", "site"])(
    "creates and publishes the headshot before the author in %s",
    async (space) => {
      const f = cma();
      const result = await create({ ...input, space });
      expect(result.complete).toBe(true);
      expect(result.entry.stage).toBe("published");
      expect(result.assets).toMatchObject([
        { key: "headshot", stage: "published", version: 3 },
      ]);
      const writes = f.writes();
      expect(writes.map(resourcePath)).toEqual([
        `assets/${result.assets[0].assetId}`,
        `assets/${result.assets[0].assetId}/files/en-US/process`,
        `assets/${result.assets[0].assetId}/published`,
        `entries/${result.entry.entryId}`,
        `entries/${result.entry.entryId}/published`,
      ]);
      expect(writes[0].body).toEqual({
        fields: {
          file: {
            "en-US": {
              contentType: "image/png",
              fileName: "headshot.png",
              upload: input.assets[0].sourceUrl,
            },
          },
          title: { "en-US": "Example headshot" },
        },
      });
      expect(f.entries.get(result.entry.entryId)?.fields.image).toEqual({
        "en-US": assetLink(result.assets[0].assetId),
      });
      expect(writes[2].headers.get("X-Contentful-Version")).toBe("2");
      expect(writes[4].headers.get("X-Contentful-Version")).toBe("1");
      expect(
        writes.every((request) =>
          request.url.pathname.includes(
            space === "docs" ? "sample-docs" : "sample-site"
          )
        )
      ).toBe(true);
    }
  );
  it("reuses one new asset in scalar and array fields alongside existing published assets", async () => {
    const f = cma({ assets: [publishedAsset("existing")] });
    const result = await create({
      ...input,
      fields: [
        ...input.fields,
        {
          fieldId: "gallery",
          value: [
            { newAsset: "headshot" },
            assetLink("existing"),
            { newAsset: "headshot" },
          ],
        },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.assets).toHaveLength(1);
    expect(f.entries.get(result.entry.entryId)?.fields.gallery).toEqual({
      "en-US": [
        assetLink(result.assets[0].assetId),
        assetLink("existing"),
        assetLink(result.assets[0].assetId),
      ],
    });
    expect(f.assets.get("existing")?.sys.publishedVersion).toBe(2);
  });
  it("publishes multiple assets before the parent", async () => {
    const f = cma();
    const result = await create({
      ...input,
      assets: [...input.assets, { ...input.assets[0], key: "second" }],
      fields: [
        ...input.fields,
        { fieldId: "gallery", value: [{ newAsset: "second" }] },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.assets).toHaveLength(2);
    const order = f.writes().map(resourcePath);
    expect(order).toHaveLength(8);
    const entryCreate = order.indexOf(`entries/${result.entry.entryId}`);
    for (const { assetId } of result.assets) {
      const published = order.indexOf(`assets/${assetId}/published`);
      expect(published).toBeGreaterThanOrEqual(0);
      expect(published).toBeLessThan(entryCreate);
    }
  });
  it.each([
    [
      "an invalid page body",
      {
        ...input,
        contentTypeId: "guide",
        fields: [...input.fields, { fieldId: "main", value: "invalid" }],
      },
      "Invalid value for main",
    ],
    [
      "a missing required field",
      { ...input, fields: input.fields.slice(1) },
      "Required field name",
    ],
    [
      "an undeclared asset key",
      {
        ...input,
        fields: [
          { fieldId: "name", value: "Example" },
          { fieldId: "image", value: { newAsset: "unknown" } },
        ],
      },
      "declared asset key",
    ],
    [
      "newAsset in a Symbol field",
      {
        ...input,
        fields: [
          { fieldId: "name", value: { newAsset: "headshot" } },
          { fieldId: "image", value: assetLink("existing") },
        ],
      },
      "Invalid value for name",
    ],
    [
      "newAsset in an Entry link field",
      {
        ...input,
        fields: [
          ...input.fields,
          { fieldId: "author", value: { newAsset: "headshot" } },
        ],
      },
      "Invalid value for author",
    ],
    [
      "newAsset in a RichText field",
      {
        ...input,
        fields: [
          ...input.fields,
          { fieldId: "body", value: { newAsset: "headshot" } },
        ],
      },
      "Invalid value for body",
    ],
    [
      "a placeholder with extra keys",
      {
        ...input,
        fields: [
          { fieldId: "name", value: "Example" },
          { fieldId: "image", value: { extra: true, newAsset: "headshot" } },
        ],
      },
      "declared asset key",
    ],
    [
      "duplicate asset keys",
      { ...input, assets: [...input.assets, input.assets[0]] },
      "Duplicate asset keys",
    ],
    [
      "an unused asset",
      {
        ...input,
        assets: [...input.assets, { ...input.assets[0], key: "unused" }],
      },
      "Every declared asset",
    ],
    [
      "more than five assets",
      {
        ...input,
        assets: Array.from({ length: 6 }, (_, i) => ({
          ...input.assets[0],
          key: `asset${i}`,
        })),
      },
      "too_big",
    ],
    [
      "a missing existing asset",
      {
        ...input,
        fields: [
          ...input.fields,
          { fieldId: "gallery", value: [assetLink("missing")] },
        ],
      },
      "referenced Asset missing was not found",
    ],
  ])(
    "validates all fields and references before writes: %s",
    async (_case, value, message) => {
      const f = cma({ assets: [publishedAsset("existing")] });
      await expect(create(value)).rejects.toThrow(message);
      expect(f.writes()).toHaveLength(0);
    }
  );
  it.each([
    { sourceUrl: "http://example.com/image.png" },
    { sourceUrl: "file:///etc/passwd" },
    { sourceUrl: "https://user:password@example.com/x" },
    { sourceUrl: "https://example.com/x#fragment" },
    { fileName: "../photo.png" },
    { contentType: "text/html" },
    { contentType: "text/javascript" },
    { contentType: "invalid" },
    { headers: { Authorization: "secret" } },
    { method: "DELETE" },
  ])("rejects malformed file sources or control inputs %j", async (changes) => {
    const f = cma();
    await expect(
      create({ ...input, assets: [{ ...input.assets[0], ...changes }] })
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("asset-backed creation recovery", () => {
  it("recovers a persisted pre-refactor plan fixture without recreating its asset", async () => {
    const recoveryId = "saved-creation";
    const assetId = `${recoveryId}-asset-0`;
    const entryId = `${recoveryId}-entry`;
    const f = cma({
      assets: [
        {
          fields: {
            file: {
              "en-US": {
                contentType: "image/png",
                fileName: "headshot.png",
                upload: "https://avatars.slack-edge.com/headshot.png",
              },
            },
            title: { "en-US": "Example headshot" },
          },
          sys: { id: assetId, version: 1 },
        },
      ],
    });
    f.process(assetId);

    // Keep the persisted format explicit: this fixture must not be generated by
    // the current preparation code or silently follow a renamed state key.
    testState.set(CREATIONS, {
      [recoveryId]: {
        assets: [
          { id: assetId, key: "headshot", stage: "processing", version: 1 },
        ],
        configuration: configurationKey(),
        entry: { id: entryId, stage: "notAttempted", version: null },
        error: "Processing interrupted",
        fields: {
          image: { "en-US": assetLink(assetId) },
          name: { "en-US": "Example" },
        },
        input,
        locale: "en-US",
        recoveryId,
      },
    });
    const result = await createContentfulEntryWithAssets(
      { ...input, resumeFrom: recoveryId },
      "session",
      "resume-call"
    );
    expect(result).toMatchObject({
      assets: [{ assetId, stage: "published", version: 3 }],
      complete: true,
      entry: { entryId, stage: "published", version: 2 },
      publicationTarget: "published",
      recoveryId,
    });
    expect([f.assets.size, f.entries.size]).toEqual([1, 1]);
    expect(f.writes().map(resourcePath)).toEqual([
      `assets/${assetId}/published`,
      `entries/${entryId}`,
      `entries/${entryId}/published`,
    ]);
  });

  it("returns a processing timeout and resumes the same resource without duplicating it", async () => {
    const f = cma();
    f.settings.processImmediately = false;
    const result = await create();
    expect(result.complete).toBe(false);
    expect(result.error).toBe(
      `Asset ${result.assets[0].assetId} is still processing. Resume this recoveryId later; do not recreate it.`
    );
    expect(result.assets[0].stage).toBe("processing");
    expect(result.entry.stage).toBe("notAttempted");
    expect(mocks.delay).toHaveBeenCalledTimes(9);
    expect([f.assets.size, f.entries.size]).toEqual([1, 0]);
    f.process(result.assets[0].assetId);
    f.fetch.mockClear();
    const completed = await create(
      { ...input, resumeFrom: result.recoveryId },
      "resume-call"
    );
    expect(completed.complete).toBe(true);
    expect(completed.assets[0].assetId).toBe(result.assets[0].assetId);
    expect([f.assets.size, f.entries.size]).toEqual([1, 1]);
    expect(
      f
        .writes()
        .some(
          (request) => request.action === "process" || isAssetCreate(request)
        )
    ).toBe(false);
  });
  it.each([
    ["asset-create", isAssetCreate],
    ["process", (request: CmaRequest) => request.action === "process"],
    [
      "asset-publish",
      (request: CmaRequest) =>
        request.collection === "assets" && request.action === "published",
    ],
    ["entry-create", isEntryCreate],
    [
      "entry-publish",
      (request: CmaRequest) =>
        request.collection === "entries" && request.action === "published",
    ],
  ])(
    "reconciles an uncertain %s response before continuing",
    async (_failure, matches) => {
      const f = cma();
      loseResponse(f, matches);
      const partial = await create();
      expect(partial.complete).toBe(false);
      expect(partial.error).toContain("Connection lost");
      f.fetch.mockClear();
      const recovered = await create(
        { ...input, resumeFrom: partial.recoveryId },
        "resume"
      );
      expect(recovered.complete).toBe(true);
      expect([f.assets.size, f.entries.size]).toEqual([1, 1]);
      expect(recovered.entry.entryId).toBe(partial.entry.entryId);
      expect(f.writes().filter(matches)).toHaveLength(0);
    }
  );
  it("can explicitly retry a failed create-only PUT at its reserved ID after confirming 404", async () => {
    const f = cma();
    f.failWhen(isAssetCreate, new Error("Connection failed before request"), 1);
    const partial = await create();
    expect(partial).toMatchObject({
      assets: [{ stage: "creating", version: null }],
      complete: false,
    });
    expect(f.assets.size).toBe(0);
    f.fetch.mockClear();
    const recovered = await create(
      { ...input, resumeFrom: partial.recoveryId },
      "resume"
    );
    expect(recovered.complete).toBe(true);
    expect(recovered.assets[0].assetId).toBe(partial.assets[0].assetId);
    const assetRequests = f
      .requests()
      .filter(
        (request) =>
          request.collection === "assets" &&
          request.id === partial.assets[0].assetId &&
          request.action === null
      )
      .map((request) => request.method);
    expect(assetRequests.slice(0, 2)).toEqual(["GET", "PUT"]);
    expect(assetRequests.filter((method) => method === "PUT")).toHaveLength(1);
  });
  it.each([
    ["asset-version", "changed outside"],
    ["asset-metadata", "metadata"],
    ["asset-deleted", "404"],
    ["asset-archived", "archived"],
    ["entry-version", "changed outside"],
    ["entry-fields", "no longer matches the requested creation"],
  ])("blocks recovery after %s changes", async (change, message) => {
    const f = cma();
    const completed = await create();
    const asset = f.assets.get(completed.assets[0].assetId);
    const entry = f.entries.get(completed.entry.entryId);
    if (!(asset && entry)) {
      throw new Error("Missing fixture");
    }
    if (change === "asset-version") {
      bumpVersion(asset);
    }
    if (change === "asset-metadata") {
      asset.fields.title["en-US"] = "Different";
    }
    if (change === "asset-deleted") {
      f.assets.delete(asset.sys.id);
    }
    if (change === "asset-archived") {
      asset.sys.archivedVersion = 3;
    }
    if (change === "entry-version") {
      bumpVersion(entry);
    }
    if (change === "entry-fields") {
      entry.fields.name["en-US"] = "Changed";
    }
    f.fetch.mockClear();
    const result = await create(
      { ...input, resumeFrom: completed.recoveryId },
      "resume"
    );
    expect(result.error).toContain(message);
    expect(f.writes()).toHaveLength(0);
  });
  it("keeps successful assets and reports the unattempted parent after a later asset fails", async () => {
    const f = cma();
    f.failWhen(
      (request) =>
        request.action === "process" &&
        request.id?.endsWith("asset-1") === true,
      422
    );
    const result = await create({
      ...input,
      assets: [...input.assets, { ...input.assets[0], key: "second" }],
      fields: [
        ...input.fields,
        { fieldId: "gallery", value: [{ newAsset: "second" }] },
      ],
    });
    expect(result.complete).toBe(false);
    expect(result.assets.map((a) => a.stage)).toEqual([
      "published",
      "processing",
    ]);
    expect(result.entry.stage).toBe("notAttempted");
  });
  it("never overwrites a colliding resource or adopts different metadata during recovery", async () => {
    const f = cma();
    f.intercept(
      isAssetCreate,
      (request, proceed) => {
        const id = request.id ?? "";
        f.assets.set(id, {
          fields: { title: { "en-US": "Someone else's asset" } },
          sys: { id, version: 1 },
        });
        return proceed();
      },
      1
    );
    const result = await create();
    expect(result.complete).toBe(false);
    expect(result.error).toContain("409");
    f.fetch.mockClear();
    const recovery = await create(
      { ...input, resumeFrom: result.recoveryId },
      "resume"
    );
    expect(recovery.complete).toBe(false);
    expect(recovery.error).toContain("metadata");
    expect(f.writes()).toHaveLength(0);
  });
  it("refuses an existing unpublished external asset before creating anything", async () => {
    const f = cma({
      assets: [{ fields: {}, sys: { id: "draft", version: 1 } }],
    });
    await expect(
      create({
        ...input,
        fields: [
          ...input.fields,
          { fieldId: "gallery", value: [assetLink("draft")] },
        ],
      })
    ).rejects.toThrow("unpublished");
    expect(f.writes()).toHaveLength(0);
  });
  it("requires both nullable controls rather than accepting older callers", async () => {
    const f = cma();
    const { assets, resumeFrom, ...oldInput } = input;
    await expect(create(oldInput)).rejects.toThrow();
    await expect(create({ ...oldInput, assets })).rejects.toThrow();
    await expect(create({ ...oldInput, resumeFrom })).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("accepts equivalent reference objects with different JSON key order during recovery", async () => {
    const f = cma({ assets: [publishedAsset("existing")] });
    const original = {
      ...input,
      fields: [
        ...input.fields,
        { fieldId: "gallery", value: [assetLink("existing")] },
      ],
    };
    const result = await create(original);
    const reordered = {
      ...original,
      fields: [
        ...input.fields,
        {
          fieldId: "gallery",
          value: [{ sys: { id: "existing", linkType: "Asset", type: "Link" } }],
        },
      ],
      resumeFrom: result.recoveryId,
    };
    f.fetch.mockClear();
    const completed2 = await create(reordered, "resume");
    expect(completed2.complete).toBe(true);
    expect(f.writes()).toHaveLength(0);
  });
  it("rejects changed inputs and unknown recoveryIds without requests", async () => {
    const f = cma();
    const result = await create();
    f.fetch.mockClear();
    await expect(
      create(
        { ...input, contentTypeId: "different", resumeFrom: result.recoveryId },
        "resume"
      )
    ).rejects.toThrow("differ");
    await expect(
      create({ ...input, resumeFrom: "unknown" }, "resume")
    ).rejects.toThrow("Unknown recoveryId");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["the configuration", { configuration: "changed" }],
    ["the locale", { locale: "fr-FR" }],
  ])(
    "rejects a saved plan when %s changed, before any request",
    async (_case, drift) => {
      const f = cma();
      f.failWhen(isAssetPublish, 503, 1);
      const result = await create();
      const plans = z
        .record(z.string(), z.record(z.string(), z.json()))
        .parse(testState.get(CREATIONS));
      testState.set(CREATIONS, {
        [result.recoveryId]: { ...plans[result.recoveryId], ...drift },
      });
      f.fetch.mockClear();
      await expect(
        create({ ...input, resumeFrom: result.recoveryId }, "resume")
      ).rejects.toThrow("configuration or locale changed");
      await expect(create()).rejects.toThrow("configuration or locale changed");
      expect(f.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a different ID", (sys: CmaResource["sys"]) => ({ ...sys, id: "other" })],
    [
      "a different published version",
      (sys: CmaResource["sys"]) => ({
        ...sys,
        publishedVersion: (sys.version ?? 0) - 2,
      }),
    ],
    [
      "a version that was not incremented",
      (sys: CmaResource["sys"]) => ({ ...sys, version: sys.publishedVersion }),
    ],
  ])("stops when an asset publish response has %s", async (_case, change) => {
    const f = cma();
    rewriteSys(f, isAssetPublish, change);
    const result = await create();
    const [{ assetId }] = result.assets;
    expect(result).toMatchObject({
      assets: [{ stage: "publishing" }],
      complete: false,
      entry: { stage: "notAttempted", version: null },
      error: `Publication of ${assetId} could not be confirmed.`,
    });
    expect(
      f.writes().filter((request) => request.collection === "entries")
    ).toHaveLength(0);
  });

  it("stops when an entry publish response is not confirmed", async () => {
    const f = cma();
    rewriteSys(f, isEntryPublish, (sys) => ({ ...sys, version: 1 }));
    const result = await create();
    expect(result).toMatchObject({
      assets: [{ stage: "published" }],
      complete: false,
      entry: { stage: "publishing", version: 1 },
      error: `Publication of ${result.entry.entryId} could not be confirmed.`,
    });
  });

  it.each([
    [
      "a different content type",
      (body: CmaResource) => ({
        ...body,
        sys: { ...body.sys, contentType: link("other", "ContentType") },
      }),
    ],
    [
      "different fields",
      (body: CmaResource) => ({
        ...body,
        fields: { ...body.fields, name: { "en-US": "Other" } },
      }),
    ],
  ])("stops when entry creation returns %s", async (_case, change) => {
    const f = cma();
    f.intercept(
      isEntryCreate,
      async (_request, proceed) => {
        const response = await proceed();
        // SAFETY: The fake serializes stored CMA resources for this create-only PUT.
        const body = (await response.json()) as CmaResource;
        return Response.json(change(body), { status: response.status });
      },
      1
    );
    const result = await create();
    expect(result).toMatchObject({
      complete: false,
      entry: { stage: "creating", version: null },
      error: "Entry creation returned unexpected content.",
    });
    expect(f.writes().filter(isEntryPublish)).toHaveLength(0);
  });

  it("stops when a newly created asset is reported as already published", async () => {
    const f = cma();
    rewriteSys(f, isAssetCreate, (sys) => ({ ...sys, publishedVersion: 1 }));
    const result = await create();
    const [{ assetId }] = result.assets;
    expect(result).toMatchObject({
      assets: [{ stage: "creating", version: null }],
      complete: false,
      entry: { stage: "notAttempted" },
      error: `${assetId} has an unexpected publication state.`,
    });
    expect(
      f.writes().filter((request) => request.action !== null)
    ).toHaveLength(0);
  });

  it("retains progress after cancellation during processing", async () => {
    const f = cma();
    f.settings.processImmediately = false;
    const controller = new AbortController();
    mocks.delay.mockImplementation(() => {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    });
    const result = await create(input, "create", controller.signal);
    expect(result.complete).toBe(false);
    expect(result.error).toBe("Cancelled");
    expect(result.assets[0].stage).toBe("processing");
    expect(result.entry.stage).toBe("notAttempted");
    expect(result.assets[0].version).toBe(1);
    expect([f.assets.size, f.entries.size]).toEqual([1, 0]);
  });
});

beforeEach(installTestState);

beforeEach(() => {
  vi.spyOn(assetRuntime, "delay").mockImplementation(mocks.delay);
});
