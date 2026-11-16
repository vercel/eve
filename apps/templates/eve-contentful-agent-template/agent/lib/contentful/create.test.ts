import { describe, expect, it } from "vitest";

import { createContentfulEntry } from "./create";
import { contentfulCreateInputSchema } from "./input-schemas";
import { PAGE_ROUTES, QUERY_SPACES } from "./model";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";
import type { RawContentType } from "./types";

const input = {
  assets: null,
  contentTypeId: "codeBlock",
  fields: [{ fieldId: "code", value: "console.log('hello')" }],
  resumeFrom: null,
  space: "docs" as const,
};
const modelFields = [
  { id: "code", name: "Code", required: true, type: "Text" },
  {
    id: "language",
    name: "Language",
    type: "Symbol",
    validations: [{ in: ["javascript", "python"] }],
  },
  {
    id: "blocks",
    items: {
      linkType: "Entry",
      type: "Link",
      validations: [{ linkContentType: ["codeBlock"] }],
    },
    name: "Blocks",
    type: "Array",
  },
  { id: "image", linkType: "Asset", name: "Image", type: "Link" },
  { id: "body", name: "Body", type: "RichText" },
  { id: "object", name: "Object", type: "Object" },
  { id: "location", name: "Location", type: "Location" },
  { disabled: true, id: "disabled", name: "Disabled", type: "Symbol" },
] satisfies RawContentType["fields"];

const liveEntry = (id: string, sys: Partial<CmaResource["sys"]> = {}) => ({
  fields: {},
  sys: {
    contentType: link("codeBlock", "ContentType"),
    id,
    publishedVersion: 3,
    version: 5,
    ...sys,
  },
});
const liveAsset = (id: string, sys: Partial<CmaResource["sys"]> = {}) => ({
  fields: { file: { "en-US": { url: `//images.ctfassets.net/${id}` } } },
  sys: { id, publishedVersion: 1, version: 2, ...sys },
});
const cma = (seed: { assets?: CmaResource[]; entries?: CmaResource[] } = {}) =>
  createCmaFake({
    contentTypes: (id) => contentType(id, modelFields),
    ...seed,
  });
const methods = (fake: ReturnType<typeof cma>) =>
  fake.requests().map(({ method }) => method);
const spaceOf = (spaceId: string) =>
  // SAFETY: Object.keys enumerates this exact configured-space map; its returned strings are keys of that map.
  (Object.keys(QUERY_SPACES) as (keyof typeof QUERY_SPACES)[]).find(
    (space) => QUERY_SPACES[space] === spaceId
  );

describe("Contentful supporting entry creation", () => {
  it.each([
    ["docs", "sample-docs"],
    ["site", "sample-site"],
  ] as const)(
    "creates and publishes a component in %s using en-US and the returned version",
    async (space, spaceId) => {
      const fake = cma();
      const { signal } = new AbortController();
      expect(await createContentfulEntry({ ...input, space }, signal)).toEqual({
        contentTypeId: "codeBlock",
        contentfulUrl: `https://app.contentful.com/spaces/${spaceId}/environments/master/entries/created-0`,
        entryId: "created-0",
        environmentId: "master",
        outcome: "created",
        publication: "published",
        spaceId,
        version: 2,
      });
      const [schema, create, publish, ...rest] = fake.requests();
      expect(rest).toEqual([]);
      expect(schema.url.pathname).toBe(
        `/spaces/${spaceId}/environments/master/content_types/codeBlock`
      );
      expect(create.url.href).toBe(
        `https://api.contentful.com/spaces/${spaceId}/environments/master/entries`
      );
      expect(create.method).toBe("POST");
      expect(create.headers.get("X-Contentful-Content-Type")).toBe("codeBlock");
      expect(create.init.signal).toBe(signal);
      expect(create.body).toEqual({
        fields: { code: { "en-US": "console.log('hello')" } },
      });
      expect(publish.url.pathname).toBe(
        `/spaces/${spaceId}/environments/master/entries/created-0/published`
      );
      expect(publish.method).toBe("PUT");
      expect(publish.headers.get("X-Contentful-Version")).toBe("1");
      expect(publish.init.signal).toBe(signal);
      expect(publish.body).toBeUndefined();
      expect(fake.entries.get("created-0")?.sys).toMatchObject({
        publishedVersion: 1,
        version: 2,
      });
    }
  );

  it.each(
    Object.values(PAGE_ROUTES).map((route) => [route.contentTypeId, route])
  )(
    "requires the saved creation workflow for routed page %s before any API request",
    async (contentTypeId, route) => {
      const fake = cma();
      const space = spaceOf(route.spaceId);
      expect(space).toBeDefined();
      await expect(
        createContentfulEntry({
          ...input,
          contentTypeId,
          space: space ?? "docs",
        })
      ).rejects.toThrow("Page content type");
      expect(fake.fetch).not.toHaveBeenCalled();
    }
  );

  it("scopes the route disallowlist by space", async () => {
    cma();
    expect(
      await createContentfulEntry({ ...input, contentTypeId: "blogPost" })
    ).toMatchObject({ publication: "published" });
  });

  it("references returned and existing published IDs without publishing their pending changes", async () => {
    const fake = cma({
      assets: [liveAsset("asset")],
      entries: [liveEntry("existing")],
    });
    const child = await createContentfulEntry(input);
    expect(
      await createContentfulEntry({
        ...input,
        contentTypeId: "codeBlockTabs",
        fields: [
          ...input.fields,
          {
            fieldId: "blocks",
            value: [link(child.entryId), link("existing")],
          },
          { fieldId: "image", value: link("asset", "Asset") },
        ],
      })
    ).toMatchObject({ entryId: "created-1", publication: "published" });
    expect(
      fake.writes().map(({ action, id, method }) => [method, id, action])
    ).toEqual([
      ["POST", null, null],
      ["PUT", "created-0", "published"],
      ["POST", null, null],
      ["PUT", "created-1", "published"],
    ]);
    expect(
      fake
        .requests()
        .filter(({ url }) => url.searchParams.has("sys.id[in]"))
        .map(({ collection, url }) => [
          collection,
          url.searchParams.get("sys.id[in]"),
        ])
    ).toEqual([
      ["entries", "created-0,existing"],
      ["assets", "asset"],
    ]);
    expect(fake.entries.get("existing")?.sys).toMatchObject({
      publishedVersion: 3,
      version: 5,
    });
    expect(fake.assets.get("asset")?.sys).toMatchObject({
      publishedVersion: 1,
      version: 2,
    });
  });

  it.each([
    ["Entry", "missing", null, "blocks: referenced Entry target was not found"],
    [
      "Entry",
      "draft",
      liveEntry("target", { publishedVersion: undefined, version: 1 }),
      "blocks: referenced Entry target is unpublished or archived",
    ],
    [
      "Entry",
      "archived",
      liveEntry("target", {
        archivedVersion: 6,
        publishedVersion: undefined,
        version: 7,
      }),
      "blocks: referenced Entry target is unpublished or archived",
    ],
    [
      "Entry",
      "wrong-type",
      liveEntry("target", { contentType: link("wrong", "ContentType") }),
      "blocks: reference target has a disallowed content type",
    ],
    ["Asset", "missing", null, "image: referenced Asset target was not found"],
    [
      "Asset",
      "draft",
      liveAsset("target", { publishedVersion: undefined, version: 1 }),
      "image: referenced Asset target is unpublished or archived",
    ],
    [
      "Asset",
      "archived",
      liveAsset("target", {
        archivedVersion: 3,
        publishedVersion: undefined,
        version: 4,
      }),
      "image: referenced Asset target is unpublished or archived",
    ],
  ] as const)(
    "rejects a %s %s target before creation",
    async (linkType, _state, target, message) => {
      const fake = cma(
        linkType === "Entry"
          ? { entries: target ? [target] : [] }
          : { assets: target ? [target] : [] }
      );
      await expect(
        createContentfulEntry({
          ...input,
          fields: [
            ...input.fields,
            linkType === "Entry"
              ? { fieldId: "blocks", value: [link("target")] }
              : { fieldId: "image", value: link("target", "Asset") },
          ],
        })
      ).rejects.toThrow(message);
      expect(fake.writes()).toEqual([]);
    }
  );

  it("rejects a malformed link ID by schema, before looking up references", async () => {
    const fake = cma({ entries: [liveEntry("target")] });
    await expect(
      createContentfulEntry({
        ...input,
        fields: [
          ...input.fields,
          { fieldId: "blocks", value: [link("../escape")] },
        ],
      })
    ).rejects.toThrow("Invalid value for blocks");
    expect(
      fake.requests().some((r) => r.url.searchParams.has("sys.id[in]"))
    ).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it("requires at least one field for a supporting entry before any API request", async () => {
    const fake = cma();
    await expect(
      createContentfulEntry({ ...input, fields: [] })
    ).rejects.toThrow("requires at least one field");
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("enforces the distinct-reference limit across creation fields before reference lookups", async () => {
    const fake = cma();
    await expect(
      createContentfulEntry({
        ...input,
        fields: [
          ...input.fields,
          {
            fieldId: "blocks",
            value: Array.from({ length: 100 }, (_, index) =>
              link(`target-${index}`)
            ),
          },
          { fieldId: "image", value: link("target-image", "Asset") },
        ],
      })
    ).rejects.toThrow("Creation fields exceed 100 distinct references");
    expect(fake.requests().map(({ collection }) => collection)).toEqual([
      "content_types",
    ]);
  });

  it("rejects more than 100 items in one reference array", async () => {
    const fake = cma({ entries: [liveEntry("target")] });
    await expect(
      createContentfulEntry({
        ...input,
        fields: [
          ...input.fields,
          {
            fieldId: "blocks",
            value: Array.from({ length: 101 }, () => link("target")),
          },
        ],
      })
    ).rejects.toThrow("Invalid value for blocks");
    expect(fake.writes()).toEqual([]);
  });

  it.each(
    [
      [{ fieldId: "language", value: "python" }],
      [{ fieldId: "code", value: "" }],
      [{ fieldId: "code", value: 42 }],
      [...input.fields, { fieldId: "language", value: "invalid" }],
      [...input.fields, { fieldId: "body", value: {} }],
      [...input.fields, { fieldId: "object", value: {} }],
      [...input.fields, { fieldId: "location", value: {} }],
      [...input.fields, { fieldId: "disabled", value: "x" }],
      [...input.fields, { fieldId: "unknown", value: "x" }],
      [...input.fields, { fieldId: "blocks", value: [link("../escape")] }],
    ].map((fields) => ({ fields }))
  )(
    "rejects unsupported or incomplete fields before writes: %j",
    async ({ fields }) => {
      const fake = cma();
      await expect(
        createContentfulEntry({ ...input, fields })
      ).rejects.toThrow();
      expect(fake.writes()).toEqual([]);
    }
  );

  it("rejects malformed inputs and endpoint escapes before any API call", async () => {
    const fake = cma();
    const invalid = [
      { ...input, space: "other" },
      { ...input, contentTypeId: "../guide" },
      { ...input, contentTypeId: "type?x=1" },
      { ...input, contentTypeId: "https://example.com" },
      { ...input, contentTypeId: "x".repeat(129) },
      { ...input, entryId: "existing" },
      { ...input, locale: "en-US" },
      { ...input, headers: {} },
      { ...input, method: "PUT" },
      { ...input, environmentId: "other" },
      { ...input, fields: [...input.fields, ...input.fields] },
      { ...input, fields: [{ fieldId: "code", value: null }] },
      { ...input, fields: [{ fieldId: "code", value: "x".repeat(100_000) }] },
      {
        ...input,
        fields: Array.from({ length: 21 }, (_, i) => ({
          fieldId: `field${i}`,
          value: "x",
        })),
      },
    ];
    for await (const value of invalid) {
      expect(contentfulCreateInputSchema.safeParse(value).success).toBe(false);

      await expect(
        // SAFETY: Intentionally invalid creation values test runtime schema rejection independently of static typing.
        createContentfulEntry(value as typeof input)
      ).rejects.toThrow();
    }
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422, 429, 500])(
    "surfaces creation API %s failures without retrying or publishing",
    async (status) => {
      const fake = cma();
      fake.failWhen(({ method }) => method === "POST", status);
      await expect(createContentfulEntry(input)).rejects.toThrow(
        `Contentful API returned ${status}`
      );
      expect(methods(fake)).toEqual(["GET", "POST"]);
    }
  );

  it("does not retry an uncertain creation", async () => {
    const fake = cma();
    fake.failWhen(
      ({ method }) => method === "POST",
      new TypeError("Connection lost")
    );
    await expect(createContentfulEntry(input)).rejects.toThrow(
      "Query for the entry before retrying"
    );
    expect(methods(fake)).toEqual(["GET", "POST"]);
  });

  it.each([409, 422, 500, "network"] as const)(
    "preserves the created ID when publication is unconfirmed: %s",
    async (failure) => {
      const fake = cma();
      fake.failWhen(
        ({ action }) => action === "published",
        failure === "network" ? new TypeError("Connection lost") : failure
      );
      expect(await createContentfulEntry(input)).toMatchObject({
        entryId: "created-0",
        error: expect.any(String),
        outcome: "created",
        publication: "unconfirmed",
        version: 1,
      });
      expect(methods(fake)).toEqual(["GET", "POST", "PUT"]);
    }
  );

  it.each(["GET", "POST"])(
    "stops subsequent writes when cancelled during %s",
    async (method) => {
      const controller = new AbortController();
      const fake = cma();
      fake.intercept(
        (request) => request.method === method,
        async (_request, proceed) => {
          const response = await proceed();
          controller.abort();
          return response;
        }
      );
      const result = createContentfulEntry(input, controller.signal);
      const assertion =
        method === "GET"
          ? expect(result).rejects.toMatchObject({ name: "AbortError" })
          : expect(result).resolves.toMatchObject({
              entryId: "created-0",
              publication: "unconfirmed",
            });
      await assertion;
      expect(
        fake.requests().every(({ init }) => init.signal === controller.signal)
      ).toBe(true);
      expect(methods(fake)).toEqual(
        method === "GET" ? ["GET"] : ["GET", "POST"]
      );
    }
  );

  it("keeps a confirmed publication when cancelled after the publish response", async () => {
    const controller = new AbortController();
    const fake = cma();
    fake.intercept(
      ({ action }) => action === "published",
      async (_request, proceed) => {
        const response = await proceed();
        controller.abort();
        return response;
      }
    );
    expect(await createContentfulEntry(input, controller.signal)).toMatchObject(
      { entryId: "created-0", publication: "published", version: 2 }
    );
    expect(methods(fake)).toEqual(["GET", "POST", "PUT"]);
  });

  it.each([
    ["a different entry ID", { id: "created-other" }],
    ["no published version", { publishedVersion: undefined }],
    ["an archived entry", { archivedVersion: 2 }],
    ["a version that was not incremented", { version: 1 }],
  ] as const)(
    "reports publication as unconfirmed when the publish response has %s",
    async (_case, sys) => {
      const fake = cma();
      fake.intercept(
        ({ action }) => action === "published",
        async (_request, proceed) => {
          const response = await proceed();
          // SAFETY: The fake serializes stored CMA resources; only sys is rewritten.
          const body = (await response.json()) as CmaResource;
          return Response.json(
            { ...body, sys: { ...body.sys, ...sys } },
            { status: response.status }
          );
        },
        1
      );
      expect(await createContentfulEntry(input)).toMatchObject({
        entryId: "created-0",
        error: "Contentful did not confirm publication of the created entry.",
        outcome: "created",
        publication: "unconfirmed",
        version: 1,
      });
      expect(methods(fake)).toEqual(["GET", "POST", "PUT"]);
    }
  );

  it("does no work when already cancelled", async () => {
    const fake = cma();
    await expect(
      createContentfulEntry(input, AbortSignal.abort())
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("does not write when schema discovery fails", async () => {
    const fake = createCmaFake();
    await expect(createContentfulEntry(input)).rejects.toThrow("404");
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: "../escape", version: 1 },
    { id: "created-0" },
    { contentType: link("guide", "ContentType"), id: "created-0", version: 1 },
  ])("never publishes malformed creation identity/version: %j", async (sys) => {
    const fake = cma();
    fake.intercept(
      ({ method }) => method === "POST",
      () => Response.json({ sys })
    );
    const assertion =
      sys.id === "../escape"
        ? expect(createContentfulEntry(input)).rejects.toThrow(
            "no valid entry ID"
          )
        : expect(createContentfulEntry(input)).resolves.toMatchObject({
            entryId: "created-0",
            publication: "unconfirmed",
          });
    await assertion;
    expect(methods(fake)).toEqual(["GET", "POST"]);
  });
});
