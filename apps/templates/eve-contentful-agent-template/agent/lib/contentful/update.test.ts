import { describe, expect, it } from "vitest";

import { contentfulUpdateInputSchema } from "./input-schemas";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";
import type { RawContentType } from "./types";
import { updateContentfulFields } from "./update";

const input = {
  changes: [
    { fieldId: "title", operation: "set" as const, value: "New title" },
  ],
  entryId: "guide",
  expectedVersion: 7,
  space: "docs" as const,
};
type BatchInput = Parameters<typeof updateContentfulFields>[0];
type ChangeValue = BatchInput["entries"][number]["changes"][number]["value"];
type EntryInput = BatchInput["entries"][number] & {
  space: BatchInput["space"];
};

const batchInput = (single: EntryInput) => {
  const { space, ...entry } = single;
  return { entries: [entry], space };
};

const modelFields = [
  { id: "title", name: "Title", required: true, type: "Symbol" },
  { id: "description", name: "Description", type: "Text" },
  {
    id: "count",
    name: "Count",
    type: "Integer",
    validations: [{ range: { max: 10, min: 0 } }],
  },
  { id: "score", name: "Score", type: "Number" },
  { id: "featured", name: "Featured", type: "Boolean" },
  { id: "date", name: "Date", type: "Date" },
  {
    id: "labels",
    items: { type: "Symbol", validations: [{ in: ["one", "two"] }] },
    name: "Labels",
    type: "Array",
  },
  {
    id: "category",
    linkType: "Entry",
    name: "Category",
    type: "Link",
    validations: [{ linkContentType: ["category"] }],
  },
  { id: "image", linkType: "Asset", name: "Image", type: "Link" },
  {
    id: "related",
    items: {
      linkType: "Entry",
      type: "Link",
      validations: [{ linkContentType: ["category"] }],
    },
    name: "Related",
    type: "Array",
  },
  { id: "body", name: "Body", type: "RichText" },
  { id: "object", name: "Object", type: "Object" },
  { id: "location", name: "Location", type: "Location" },
  { disabled: true, id: "old", name: "Old", type: "Symbol" },
  { id: "hidden", name: "Hidden", omitted: true, type: "Symbol" },
  {
    id: "short",
    name: "Short",
    type: "Symbol",
    validations: [{ size: { max: 5, min: 2 } }],
  },
] satisfies RawContentType["fields"];

const guide = (
  overrides: {
    fields?: CmaResource["fields"];
    sys?: Partial<CmaResource["sys"]>;
  } = {}
): CmaResource => ({
  fields: overrides.fields ?? {
    body: { "en-US": { content: [], nodeType: "document" } },
    description: { "de-DE": "Beschreibung", "en-US": "Description" },
    title: { "de-DE": "Titel", "en-US": "Old title" },
  },
  metadata: {
    concepts: [link("concept", "TaxonomyConcept")],
    tags: [link("tag", "Tag")],
  },
  sys: {
    contentType: link("guideType", "ContentType"),
    id: "guide",
    publishedVersion: 6,
    version: 7,
    ...overrides.sys,
  },
});
const category = (id: string): CmaResource => ({
  fields: {},
  sys: { contentType: link("category", "ContentType"), id, version: 1 },
});

const cma = ({
  assets = [],
  entries = [guide()],
}: {
  assets?: CmaResource[];
  entries?: CmaResource[];
} = {}) =>
  createCmaFake({
    assets,
    contentTypes: [contentType("guideType", modelFields, "Guide")],
    entries,
  });

describe("Contentful field updates", () => {
  it.each([
    ["docs", "sample-docs"],
    ["site", "sample-site"],
  ] as const)(
    "updates only selected en-US values in %s",
    async (space, spaceId) => {
      const entry = guide();
      const fake = cma();
      const controller = new AbortController();
      expect(
        await updateContentfulFields(
          batchInput({ ...input, space }),
          controller.signal
        )
      ).toEqual({
        complete: true,
        results: [
          {
            contentfulUrl: `https://app.contentful.com/spaces/${spaceId}/environments/master/entries/guide`,
            entryId: "guide",
            outcome: "updated",
            previousVersion: 7,
            status: "changed",
            updatedFields: ["title"],
            version: 8,
          },
        ],
      });
      const [write, ...rest] = fake.writes();
      expect(rest).toEqual([]);
      expect(write.url.href).toBe(
        `https://api.contentful.com/spaces/${spaceId}/environments/master/entries/guide`
      );
      expect(write.method).toBe("PUT");
      expect(Object.fromEntries(write.headers)).toMatchObject({
        authorization: `Bearer ${process.env.CONTENTFUL_MANAGEMENT_TOKEN}`,
        "content-type": "application/vnd.contentful.management.v1+json",
        "x-contentful-version": "7",
      });
      expect(write.init.signal).toBe(controller.signal);
      expect(write.body).toEqual({
        fields: {
          ...entry.fields,
          title: { "de-DE": "Titel", "en-US": "New title" },
        },
        metadata: entry.metadata,
      });
      expect(fake.fetch).toHaveBeenCalledTimes(3);
      expect(fake.entries.get("guide")?.sys).toMatchObject({
        publishedVersion: 6,
        version: 8,
      });
    }
  );

  it("removes only en-US and keeps an explicit empty field when it has no other locales", async () => {
    const fake = cma({
      entries: [
        guide({
          fields: {
            description: { "de-DE": "Beschreibung", "en-US": "Description" },
            short: { "en-US": "Short" },
          },
        }),
      ],
    });
    const result = await updateContentfulFields(
      batchInput({
        ...input,
        changes: [
          { fieldId: "description", operation: "unset", value: null },
          { fieldId: "short", operation: "unset", value: null },
        ],
      })
    );
    expect(result).toMatchObject({
      complete: true,
      results: [
        { outcome: "updated", updatedFields: ["description", "short"] },
      ],
    });
    const [write, ...rest] = fake.writes();
    expect(rest).toEqual([]);
    // SAFETY: Entry saves send a fields object; a malformed body fails the equality checks below.
    const { fields } = write.body as { fields: CmaResource["fields"] };
    expect(fields.description).toEqual({ "de-DE": "Beschreibung" });
    expect(fields.short).toEqual({});
  });

  it("adds absent fields, replaces arrays, and leaves drafts unpublished", async () => {
    const fake = cma({
      entries: [
        guide({
          fields: { labels: { "en-US": ["one"] } },
          sys: { publishedVersion: undefined },
        }),
      ],
    });
    const result = await updateContentfulFields(
      batchInput({
        ...input,
        changes: [
          { fieldId: "description", operation: "set", value: "Added" },
          { fieldId: "labels", operation: "set", value: ["two"] },
          { fieldId: "count", operation: "set", value: 3 },
          { fieldId: "score", operation: "set", value: 3.5 },
          { fieldId: "featured", operation: "set", value: false },
          { fieldId: "date", operation: "set", value: "2026-09-10T04:00:00Z" },
        ],
      })
    );
    expect(result).toMatchObject({
      complete: true,
      results: [{ outcome: "updated", status: "draft" }],
    });
    const [write] = fake.writes();
    expect(write.body).toMatchObject({
      fields: {
        count: { "en-US": 3 },
        date: { "en-US": "2026-09-10T04:00:00Z" },
        description: { "en-US": "Added" },
        featured: { "en-US": false },
        labels: { "en-US": ["two"] },
        score: { "en-US": 3.5 },
      },
    });
  });

  it("validates references in batches, including Entry/Asset IDs that collide", async () => {
    const fake = cma({
      assets: [{ fields: {}, sys: { id: "same", version: 1 } }],
      entries: [guide(), category("same"), category("other")],
    });
    await updateContentfulFields(
      batchInput({
        ...input,
        changes: [
          {
            fieldId: "category",
            operation: "set",
            value: link("same"),
          },
          { fieldId: "image", operation: "set", value: link("same", "Asset") },
          {
            fieldId: "related",
            operation: "set",
            value: [link("same"), link("other")],
          },
        ],
      })
    );
    expect(
      fake
        .requests()
        .filter(({ url }) => url.searchParams.has("sys.id[in]"))
        .map(({ collection, url }) => [
          collection,
          url.searchParams.get("sys.id[in]"),
        ])
    ).toEqual([
      ["entries", "same,other"],
      ["assets", "same"],
    ]);
    expect(fake.writes()).toHaveLength(1);
  });

  it.each<[string, ChangeValue, string[]]>([
    [
      "title",
      42,
      ["Invalid value for title:", "expected string, received number"],
    ],
    [
      "count",
      1.5,
      ["Invalid value for count:", "expected int, received number"],
    ],
    [
      "count",
      -1,
      [
        "Invalid value for count: Value is outside the field's allowed size or range.",
      ],
    ],
    [
      "count",
      11,
      [
        "Invalid value for count: Value is outside the field's allowed size or range.",
      ],
    ],
    [
      "featured",
      "true",
      ["Invalid value for featured:", "expected boolean, received string"],
    ],
    [
      "date",
      "yesterday",
      ["Invalid value for date:", "Invalid ISO date", "Invalid ISO datetime"],
    ],
    [
      "labels",
      ["bad"],
      ["Invalid value for labels: Value is not in the field's allowed values."],
    ],
    [
      "short",
      "x",
      [
        "Invalid value for short: Value is outside the field's allowed size or range.",
      ],
    ],
    [
      "short",
      "too long",
      [
        "Invalid value for short: Value is outside the field's allowed size or range.",
      ],
    ],
    ["title", "", ["Required field title cannot be empty."]],
    [
      "body",
      {},
      [
        "Invalid value for body: Invalid RichText document: nodeType: Value must be one of expected values",
      ],
    ],
    ["object", {}, ["Field type Object is not supported for writes."]],
    [
      "location",
      { lat: 0, lon: 0 },
      ["Field type Location is not supported for writes."],
    ],
    ["old", "x", ["Field old is disabled or omitted and cannot be written."]],
    [
      "hidden",
      "x",
      ["Field hidden is disabled or omitted and cannot be written."],
    ],
    ["missing", "x", ["Unknown field missing on content type guideType."]],
  ])(
    "rejects invalid or unsupported %s value %j before writing",
    async (fieldId, value, messages) => {
      const fake = cma();
      const update = updateContentfulFields(
        batchInput({
          ...input,
          changes: [{ fieldId, operation: "set", value }],
        })
      );
      await Promise.all(
        [
          "Entry guide failed preparation; no entries were saved: ",
          ...messages,
        ].map((message) => expect(update).rejects.toThrow(message))
      );
      expect(fake.writes()).toEqual([]);
    }
  );

  it.each([
    ["a malformed ID", link("../escape"), "must match pattern"],
    [
      "the wrong link type",
      link("asset", "Asset"),
      'Invalid input: expected \\"Entry\\"',
    ],
  ])(
    "rejects a link with %s by schema, before looking up references",
    async (_name, value, message) => {
      const fake = cma();
      const update = updateContentfulFields(
        batchInput({
          ...input,
          changes: [{ fieldId: "category", operation: "set", value }],
        })
      );
      await expect(update).rejects.toThrow("Invalid value for category: ");
      await expect(update).rejects.toThrow(message);
      expect(
        fake.requests().some((r) => r.url.searchParams.has("sys.id[in]"))
      ).toBe(false);
      expect(fake.writes()).toEqual([]);
    }
  );

  it("rejects duplicate changes to one field before writing", async () => {
    const fake = cma();
    await expect(
      updateContentfulFields(
        batchInput({
          ...input,
          changes: [
            ...input.changes,
            { fieldId: "title", operation: "unset", value: null },
          ],
        })
      )
    ).rejects.toThrow("Duplicate field IDs are not allowed.");
    expect(fake.writes()).toEqual([]);
  });

  it("rejects removing a required field", async () => {
    const fake = cma();
    await expect(
      updateContentfulFields(
        batchInput({
          ...input,
          changes: [{ fieldId: "title", operation: "unset", value: null }],
        })
      )
    ).rejects.toThrow("Required field title cannot be unset.");
    expect(fake.writes()).toEqual([]);
  });

  it("validates every change in an entry before writing a valid one", async () => {
    const fake = cma();
    await expect(
      updateContentfulFields(
        batchInput({
          ...input,
          changes: [
            ...input.changes,
            { fieldId: "count", operation: "set", value: 11 },
          ],
        })
      )
    ).rejects.toThrow(
      "Invalid value for count: Value is outside the field's allowed size or range."
    );
    expect(fake.writes()).toEqual([]);
    expect(fake.entries.get("guide")?.fields.title).toEqual({
      "de-DE": "Titel",
      "en-US": "Old title",
    });
  });

  it.each<[Partial<CmaResource["sys"]>, string]>([
    [
      { version: 8 },
      "Entry guide failed preparation; no entries were saved: Entry identity or version has changed.",
    ],
    [
      { version: undefined },
      "Entry guide failed preparation; no entries were saved: Entry identity or version has changed.",
    ],
    [
      { id: "other" },
      "Entry guide failed preparation; no entries were saved: Entry identity or version has changed.",
    ],
    [
      { archivedVersion: 6, publishedVersion: undefined },
      "Entry guide failed preparation; no entries were saved: Archived entries cannot be updated.",
    ],
  ])(
    "rejects stale, unversioned, mismatched, or archived entries: %j",
    async (sys, message) => {
      // Keyed by the requested ID so a mismatched response identity is served.
      const fake = cma({ entries: [] });
      fake.entries.set("guide", guide({ sys }));
      await expect(updateContentfulFields(batchInput(input))).rejects.toThrow(
        message
      );
      expect(fake.fetch).toHaveBeenCalledTimes(1);
      expect(fake.writes()).toEqual([]);
    }
  );

  it.each([
    ["missing", [], "category: referenced Entry target was not found"],
    [
      "disallowed",
      [
        {
          fields: {},
          sys: {
            contentType: link("wrong", "ContentType"),
            id: "target",
            version: 1,
          },
        },
      ],
      "category: reference target has a disallowed content type",
    ],
  ] as const)(
    "rejects %s reference targets",
    async (_case, targets, message) => {
      const fake = cma({ entries: [guide(), ...targets] });
      await expect(
        updateContentfulFields(
          batchInput({
            ...input,
            changes: [
              {
                fieldId: "category",
                operation: "set",
                value: link("target"),
              },
            ],
          })
        )
      ).rejects.toThrow(message);
      expect(fake.writes()).toEqual([]);
    }
  );

  it.each([400, 401, 403, 409, 422, 429, 500])(
    "surfaces write failures (%s) without retrying",
    async (status) => {
      const fake = cma();
      fake.failWhen(
        ({ method }) => method === "PUT",
        () =>
          Response.json(
            {
              details: {
                errors: [
                  { details: "Invalid title", path: ["fields", "title"] },
                ],
              },
            },
            { status }
          )
      );
      expect(await updateContentfulFields(batchInput(input))).toMatchObject({
        complete: false,
        results: [
          {
            entryId: "guide",
            error: expect.stringContaining(
              `Contentful API returned ${status} (fields.title: Invalid title)`
            ),
            outcome: "failed",
          },
        ],
      });
      expect(fake.writes()).toHaveLength(1);
    }
  );

  it("does not write when cancelled during schema discovery", async () => {
    const controller = new AbortController();
    const fake = cma();
    fake.intercept(
      ({ collection }) => collection === "content_types",
      (_request, proceed) => {
        controller.abort();
        return proceed();
      }
    );
    await expect(
      updateContentfulFields(batchInput(input), controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    [{ space: "other" }, "Space is not configured."],
    [
      { entryId: "../escape" },
      "Invalid string: must match pattern /^[A-Za-z0-9_-]+$/u",
    ],
    [
      { entryId: "https://evil.example" },
      "Invalid string: must match pattern /^[A-Za-z0-9_-]+$/u",
    ],
    [
      { expectedVersion: null },
      "Invalid input: expected number, received null",
    ],
    [{ expectedVersion: 0 }, "Too small: expected number to be >=1"],
    [{ expectedVersion: 1.5 }, "Invalid input: expected int, received number"],
    [{ url: "https://evil.example" }, 'Unrecognized key: \\"url\\"'],
    [{ headers: {} }, 'Unrecognized key: \\"headers\\"'],
    [{ locale: "de-DE" }, 'Unrecognized key: \\"locale\\"'],
    [{ changes: [] }, "Too small: expected array to have >=1 items"],
    [
      { changes: [...input.changes, ...input.changes] },
      "Duplicate field IDs are not allowed.",
    ],
    [
      { changes: [{ fieldId: "title", operation: "set", value: null }] },
      "title: use null only with unset.",
    ],
    [
      { changes: [{ fieldId: "title", operation: "unset", value: "wrong" }] },
      "title: use null only with unset.",
    ],
    [
      { changes: [{ fieldId: "title", operation: "set" }] },
      "Invalid input: expected string, received undefined",
    ],
    [
      { changes: [{ fieldId: "../title", operation: "set", value: "x" }] },
      "Invalid string: must match pattern /^[A-Za-z0-9_-]+$/u",
    ],
    [
      {
        changes: [
          {
            fieldId: "description",
            operation: "set",
            value: "x".repeat(100_001),
          },
        ],
      },
      "Field changes exceed 100,000 serialized characters.",
    ],
    [
      {
        changes: Array.from({ length: 21 }, (_, i) => ({
          fieldId: `field${i}`,
          operation: "set",
          value: "x",
        })),
      },
      "Too big: expected array to have <=20 items",
    ],
  ])(
    "rejects malformed or oversized inputs before requests: %j",
    async (override, message) => {
      const fake = cma();
      expect(
        contentfulUpdateInputSchema.safeParse(
          // SAFETY: Intentionally malformed overrides test runtime input rejection independently of static typing.
          batchInput({ ...input, ...override } as EntryInput)
        ).success
      ).toBe(false);
      await expect(
        updateContentfulFields(
          // SAFETY: Intentionally malformed overrides test runtime input rejection independently of static typing.
          batchInput({ ...input, ...override } as EntryInput)
        )
      ).rejects.toThrow(message);
      expect(fake.fetch).not.toHaveBeenCalled();
    }
  );
});
