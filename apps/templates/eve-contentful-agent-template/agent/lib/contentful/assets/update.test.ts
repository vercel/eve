import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { testState, installTestState } from "#lib/testing/state";

import type { JsonValue } from "../../json";
import { contentType, createCmaFake, link } from "../testing/cma";
import type { CmaFake, CmaRequest, CmaResource } from "../testing/cma";
import type { ReadAssetFile } from "./files";
import { updateContentfulFieldsWithAssets } from "./update-state";
import { assetRuntime } from "./workflow";

const mocks = vi.hoisted(() => ({ delay: vi.fn() }));
const UPDATES = "contentful.asset-updates";
const ABORTED = /aborted/iu;

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
  entries: [
    {
      changes: [
        { fieldId: "image", operation: "set", value: { newAsset: "headshot" } },
        {
          fieldId: "darkImage",
          operation: "set",
          value: { newAsset: "headshot" },
        },
      ],
      entryId: "media",
      expectedVersion: 7,
    },
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

const mediaEntry = (id: string): CmaResource => ({
  fields: {
    darkImage: { "en-US": assetLink("old") },
    image: { "en-US": assetLink("old"), "fr-FR": assetLink("french") },
    name: { "en-US": "Keep me" },
  },
  metadata: { tags: [link("tag", "Tag")] },
  sys: {
    contentType: link("mediaType", "ContentType"),
    id,
    publishedVersion: 6,
    version: 7,
  },
});
const cma = () =>
  createCmaFake({
    assets: [
      {
        fields: {
          file: { "en-US": { url: "//images.ctfassets.net/existing" } },
        },
        sys: { id: "existing", publishedVersion: 1, version: 2 },
      },
    ],
    contentTypes: (id) =>
      contentType(id, [
        { id: "name", name: "Name", required: true, type: "Symbol" },
        {
          id: "image",
          linkType: "Asset",
          name: "Image",
          required: true,
          type: "Link",
        },
        { id: "darkImage", linkType: "Asset", name: "Dark", type: "Link" },
        {
          id: "gallery",
          items: { linkType: "Asset", type: "Link" },
          name: "Gallery",
          type: "Array",
        },
        { id: "author", linkType: "Entry", name: "Author", type: "Link" },
        { id: "body", name: "Body", type: "RichText" },
      ]),
    entries: [mediaEntry("media"), mediaEntry("second")],
  });
const entry = (f: CmaFake, id: string) => {
  const raw = f.entries.get(id);
  if (!raw) {
    throw new Error(`Missing entry ${id}`);
  }
  return raw;
};
const humanEdit = (raw: CmaResource, name = "Human edit") => {
  raw.fields.name["en-US"] = name;
  raw.sys.version = (raw.sys.version ?? 0) + 1;
};
const saveOf = (entryId: string) => (request: CmaRequest) =>
  request.method === "PUT" &&
  request.collection === "entries" &&
  request.id === entryId;
const isAssetPublish = (request: CmaRequest) =>
  request.collection === "assets" && request.action === "published";

const update = async (
  value: JsonValue = input,
  callId = "update-call",
  signal?: AbortSignal,
  readFile?: ReadAssetFile
) => {
  const result = await updateContentfulFieldsWithAssets(
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

const entryWrites = (f: CmaFake) =>
  f.writes().filter((request) => request.collection === "entries");
const batchInput = {
  ...input,
  entries: [...input.entries, { ...input.entries[0], entryId: "second" }],
};
const resume = (
  value: typeof input,
  recoveryId: string,
  readFile?: ReadAssetFile
) =>
  update(
    { ...value, resumeFrom: recoveryId },
    "resume-call",
    undefined,
    readFile
  );

it.each(["docs", "site"])(
  "uploads once for both image fields and preserves the existing entry in %s",
  async (space) => {
    const f = cma();
    const original = structuredClone(entry(f, "media"));
    const readFile = vi.fn().mockResolvedValue(png);
    const result = await update(
      { ...fileInput, space },
      "binary",
      undefined,
      readFile
    );
    expect(result.complete).toBe(true);
    expect(result.assets).toMatchObject([
      { stage: "published", upload: { id: "upload-1", status: "uploaded" } },
    ]);
    expect(f.uploads.size).toBe(1);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(fileAsset.sourcePath);
    expect(f.writes()[0].body).toEqual(png);
    expect(entryWrites(f)).toHaveLength(1);
    expect(entry(f, "media")).toMatchObject({
      fields: {
        darkImage: { "en-US": assetLink(result.assets[0].assetId) },
        image: {
          "en-US": assetLink(result.assets[0].assetId),
          "fr-FR": assetLink("french"),
        },
        name: { "en-US": "Keep me" },
      },
      metadata: original.metadata,
      sys: { publishedVersion: 6, version: 8 },
    });
    expect(result.results).toMatchObject([
      {
        entryId: "media",
        outcome: "updated",
        previousVersion: 7,
        status: "changed",
        version: 8,
      },
    ]);
    expect(f.assets.size).toBe(2);
  }
);

it("shares one URL asset across entries and mixed reference arrays", async () => {
  const f = cma();
  const result = await update({
    ...batchInput,
    entries: [
      input.entries[0],
      {
        ...batchInput.entries[1],
        changes: [
          {
            fieldId: "gallery",
            operation: "set",
            value: [
              assetLink("existing"),
              { newAsset: "headshot" },
              assetLink("existing"),
            ],
          },
        ],
      },
    ],
  });
  expect(result.complete).toBe(true);
  expect(entry(f, "second").fields.gallery["en-US"]).toEqual([
    assetLink("existing"),
    assetLink(result.assets[0].assetId),
    assetLink("existing"),
  ]);
  expect(result.assets).toHaveLength(1);
  expect(f.uploads.size).toBe(0);
  expect(entryWrites(f)).toHaveLength(2);
});

it("resolves keys across the batch so each entry links its own asset", async () => {
  const f = cma();
  const result = await update({
    ...batchInput,
    assets: [...input.assets, { ...input.assets[0], key: "second" }],
    entries: [
      input.entries[0],
      {
        changes: [
          { fieldId: "image", operation: "set", value: { newAsset: "second" } },
        ],
        entryId: "second",
        expectedVersion: 7,
      },
    ],
  });
  expect(result.complete).toBe(true);
  const [first, second] = result.assets.map(({ assetId }) => assetId);
  expect(entry(f, "media").fields.image["en-US"]).toEqual(assetLink(first));
  expect(entry(f, "second").fields.image["en-US"]).toEqual(assetLink(second));
  expect(entry(f, "second").fields.darkImage["en-US"]).toEqual(
    assetLink("old")
  );
});

it.each([
  [
    "an asset no entry in the batch references",
    {
      ...batchInput,
      assets: [...input.assets, { ...input.assets[0], key: "unused" }],
    },
    "Every declared asset",
  ],
  [
    "newAsset in a Symbol field",
    {
      ...input,
      entries: [
        {
          ...input.entries[0],
          changes: [
            {
              fieldId: "name",
              operation: "set",
              value: { newAsset: "headshot" },
            },
          ],
        },
      ],
    },
    "Invalid value for name",
  ],
  [
    "newAsset in an Entry link field",
    {
      ...input,
      entries: [
        {
          ...input.entries[0],
          changes: [
            {
              fieldId: "author",
              operation: "set",
              value: { newAsset: "headshot" },
            },
          ],
        },
      ],
    },
    "Invalid value for author",
  ],
  [
    "a stale entry later in the batch",
    {
      ...batchInput,
      entries: [
        input.entries[0],
        { ...batchInput.entries[1], expectedVersion: 6 },
      ],
    },
    "version has changed",
  ],
])("rejects %s before uploading", async (_case, value, message) => {
  const f = cma();
  await expect(update(value)).rejects.toThrow(message);
  expect(f.writes()).toHaveLength(0);
});

it("validates file bytes before any asset or entry write", async () => {
  const f = cma();
  const result = await update(
    fileInput,
    "invalid-file",
    undefined,
    async () => await new Uint8Array([1, 2, 3])
  );
  expect(result.complete).toBe(false);
  expect(result.error).toContain("contentType");
  expect(f.writes()).toHaveLength(0);
});

it("leaves entries untouched when an asset write fails", async () => {
  const f = cma();
  f.failWhen(
    (request) => request.method === "PUT" && request.collection === "assets",
    new Error("Asset service unavailable")
  );
  const result = await update(
    fileInput,
    "binary-failure",
    undefined,
    async () => await png
  );
  expect(result.complete).toBe(false);
  expect(result.error).toContain("Asset service unavailable");
  expect(entryWrites(f)).toHaveLength(0);
});

it.each([false, true])(
  "reconciles a failed save with accepted=%s on explicit recovery",
  async (accepted) => {
    const f = cma();
    if (accepted) {
      f.intercept(
        saveOf("media"),
        async (_request, proceed) => {
          await proceed();
          throw new Error("Save response lost");
        },
        1
      );
    } else {
      f.failWhen(saveOf("media"), new Error("Save response lost"), 1);
    }
    const result = await update();
    expect(result.complete).toBe(false);
    expect(result.results).toMatchObject([{ outcome: "failed" }]);
    const count = f.fetch.mock.calls.length;
    expect(await update()).toEqual(result);
    expect(f.fetch.mock.calls).toHaveLength(count);
    const recovered = await resume(input, result.recoveryId);
    expect(recovered.complete).toBe(true);
    expect(entryWrites(f)).toHaveLength(accepted ? 1 : 2);
    expect(entry(f, "media").sys.version).toBe(8);
    expect(
      f.writes().filter((request) => request.collection === "assets")
    ).toHaveLength(3);
  }
);

it("preserves successful earlier saves and later human edits when resuming a batch", async () => {
  const f = cma();
  f.failWhen(saveOf("second"), new Error("Unavailable"), 1);
  const result = await update(batchInput);
  expect(result.results).toMatchObject([
    { outcome: "updated" },
    { outcome: "failed" },
  ]);
  const media = entry(f, "media");
  humanEdit(media);
  const completed1 = await resume(batchInput, result.recoveryId);
  expect(completed1.complete).toBe(true);
  expect(media.fields.name["en-US"]).toBe("Human edit");
  expect(entryWrites(f).filter(saveOf("media"))).toHaveLength(1);
});

it("retains the published asset on concurrent edits and permits a reassessed ordinary update", async () => {
  const f = cma();
  f.intercept(isAssetPublish, async (_request, proceed) => {
    const response = await proceed();
    humanEdit(entry(f, "media"));
    return response;
  });
  const result = await update();
  expect(result.complete).toBe(false);
  expect(result.error).toContain("Entry identity or version has changed");
  expect(result.assets[0].stage).toBe("published");
  expect(entryWrites(f)).toHaveLength(0);
  const completed2 = await resume(input, result.recoveryId);
  expect(completed2.complete).toBe(false);
  expect(completed2.error).toContain("Entry media changed");
  expect(completed2.error).toContain("Read and reassess");
  const ordinary = await updateContentfulFieldsWithAssets(
    {
      assets: null,
      entries: [
        {
          changes: [
            {
              fieldId: "image",
              operation: "set",
              value: assetLink(result.assets[0].assetId),
            },
          ],
          entryId: "media",
          expectedVersion: 8,
        },
      ],
      resumeFrom: null,
      space: "docs",
    },
    "session",
    "reassessed"
  );
  expect(ordinary.complete).toBe(true);
  expect(entry(f, "media").fields.name["en-US"]).toBe("Human edit");
  expect(f.assets.size).toBe(2);
});

it("rejects changed inputs and unknown recoveryIds without requests", async () => {
  const f = cma();
  const result = await update();
  f.fetch.mockClear();
  await expect(
    resume(
      { ...input, entries: [{ ...input.entries[0], expectedVersion: 8 }] },
      result.recoveryId
    )
  ).rejects.toThrow("Recovery inputs differ");
  await expect(resume(input, "contentful-create-other")).rejects.toThrow(
    "Unknown update recoveryId"
  );
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each([
  ["the configuration", { configuration: "changed" }],
  ["the locale", { locale: "fr-FR" }],
])(
  "rejects a saved update plan when %s changed, before any request",
  async (_case, drift) => {
    const f = cma();
    f.failWhen(isAssetPublish, 503, 1);
    const result = await update();
    const plans = z
      .record(z.string(), z.record(z.string(), z.json()))
      .parse(testState.get(UPDATES));
    testState.set(UPDATES, {
      [result.recoveryId]: { ...plans[result.recoveryId], ...drift },
    });
    f.fetch.mockClear();
    await expect(resume(input, result.recoveryId)).rejects.toThrow(
      "configuration or locale changed"
    );
    await expect(update()).rejects.toThrow("configuration or locale changed");
    expect(f.fetch).not.toHaveBeenCalled();
  }
);

it("returns asset progress on cancellation before saving", async () => {
  const f = cma();
  const controller = new AbortController();
  f.intercept(isAssetPublish, async (_request, proceed) => {
    const response = await proceed();
    controller.abort();
    return response;
  });
  const result = await update(input, "cancel", controller.signal);
  expect(result.complete).toBe(false);
  expect(result.error).toMatch(ABORTED);
  expect(entryWrites(f)).toHaveLength(0);
  expect(result.assets[0].stage).toBe("published");
  const completed3 = await resume(input, result.recoveryId);
  expect(completed3.complete).toBe(true);
});

it.each(["content", "version", "publication"])(
  "blocks recovery when an uncertain save has conflicting %s",
  async (change) => {
    const f = cma();
    f.intercept(
      saveOf("media"),
      async (_request, proceed) => {
        await proceed();
        throw new Error("Save response lost");
      },
      1
    );
    const result = await update();
    const media = entry(f, "media");
    if (change === "content") {
      media.fields.name["en-US"] = "Different content";
    } else if (change === "version") {
      media.sys.version = (media.sys.version ?? 0) + 1;
    } else {
      media.sys.publishedVersion = 7;
    }
    const count = f.writes().length;
    const recovered = await resume(input, result.recoveryId);
    expect(recovered.complete).toBe(false);
    expect(recovered.error).toContain("Read and reassess");
    expect(f.writes()).toHaveLength(count);
  }
);

it("reconciles an unset field omitted from Contentful's saved representation", async () => {
  const f = cma();
  const value = {
    ...input,
    entries: [
      {
        ...input.entries[0],
        changes: [
          input.entries[0].changes[0],
          { fieldId: "darkImage", operation: "unset", value: null },
        ],
      },
    ],
  };
  f.intercept(
    saveOf("media"),
    async (_request, proceed) => {
      await proceed();
      const { darkImage: _omitted, ...fields } = entry(f, "media").fields;
      entry(f, "media").fields = fields;
      throw new Error("Save response lost");
    },
    1
  );
  const result = await update(value);
  const completed4 = await update(
    { ...value, resumeFrom: result.recoveryId },
    "resume"
  );
  expect(completed4.complete).toBe(true);
  expect(entryWrites(f)).toHaveLength(1);
});

it("detects edits to a newly published asset before saving the entry", async () => {
  const f = cma();
  f.intercept(isAssetPublish, async (request, proceed) => {
    const response = await proceed();
    const asset = f.assets.get(request.id ?? "");
    if (asset) {
      asset.sys.version = (asset.sys.version ?? 0) + 1;
      asset.fields.title["en-US"] = "Human asset edit";
    }
    return response;
  });
  const result = await update();
  expect(result.complete).toBe(false);
  expect(result.error).toContain("metadata");
  expect(entryWrites(f)).toHaveLength(0);
});

it("requires nullable controls and rejects placeholders without declared assets", async () => {
  const f = cma();
  await expect(
    update({ entries: input.entries, space: input.space })
  ).rejects.toThrow();
  await expect(update({ ...input, assets: null })).rejects.toThrow();
  expect(f.writes()).toHaveLength(0);
});

it("applies a RichText patch in the same asset-backed batch", async () => {
  const f = cma();
  const paragraph = {
    content: [{ data: {}, marks: [], nodeType: "text", value: "Caption." }],
    data: {},
    nodeType: "paragraph",
  };
  const result = await update({
    ...input,
    entries: [
      {
        ...input.entries[0],
        changes: [
          ...input.entries[0].changes,
          {
            fieldId: "body",
            operation: "patch",
            value: {
              edits: [
                {
                  afterHash: null,
                  afterIndex: null,
                  nodes: [paragraph],
                  type: "insertBlocks",
                },
              ],
              embeds: null,
            },
          },
        ],
      },
    ],
  });
  expect(result.complete).toBe(true);
  expect(entry(f, "media").fields.body).toEqual({
    "en-US": { content: [paragraph], data: {}, nodeType: "document" },
  });
  expect(entryWrites(f)).toHaveLength(1);
});

beforeEach(installTestState);

beforeEach(() => {
  vi.spyOn(assetRuntime, "delay").mockImplementation(mocks.delay);
});
