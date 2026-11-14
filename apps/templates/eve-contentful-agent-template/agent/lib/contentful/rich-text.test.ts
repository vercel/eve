import { beforeEach, describe, expect, it, vi } from "vitest";

import { createContentfulEntry } from "./create";
import { validateUpdateChange } from "./field-validation";
import type {
  ContentfulCreateInput,
  ContentfulUpdateInput,
} from "./input-schemas";
import { QUERY_SPACES } from "./model";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";
import type { RawContentType } from "./types";
import { updateContentfulFields } from "./update";

type JsonValue =
  ContentfulUpdateInput["entries"][number]["changes"][number]["value"];
/* A creation field value: any JSON value except null. */
type CreateValue = ContentfulCreateInput["fields"][number]["value"];

const text = (value = "FAQ answer", marks: string[] = []) => ({
  data: {},
  marks: marks.map((type) => ({ type })),
  nodeType: "text",
  value,
});
const node = (
  nodeType: string,
  content: JsonValue[] = [],
  data: Record<string, JsonValue> = {}
) => ({ content, data, nodeType });
const doc = (...content: JsonValue[]) => node("document", content);
const paragraph = (...content: JsonValue[]) => node("paragraph", content);
const answer = doc(paragraph(text("FAQ answer", ["bold"])));
const embed = (
  id: string,
  nodeType = "embedded-entry-block",
  linkType = "Entry"
) => node(nodeType, [], { target: link(id, linkType) });
const field: RawContentType["fields"][number] = {
  id: "description",
  name: "Answer",
  type: "RichText",
};
const context = { contentTypeId: "faqItem", space: "docs" as const };
/*
 * The single body in the configured CONTENTFUL_PROTECTED_FIELDS list. Guides are
 * routed pages, so creation may supply the whole body, but later whole-value
 * writes must be rejected in favor of block patches.
 */
const PROTECTED_BODY = {
  contentTypeId: "guide",
  fieldId: "main",
  space: "docs",
} as const;

/* Reference targets that lookups can find; any other ID is missing. */
const references = {
  assets: [
    { fields: {}, sys: { id: "image", publishedVersion: 1, version: 2 } },
    { fields: {}, sys: { id: "same", publishedVersion: 1, version: 2 } },
  ],
  entries: [
    {
      fields: {},
      sys: {
        contentType: link("faqItem", "ContentType"),
        id: "same",
        publishedVersion: 1,
        version: 2,
      },
    },
    {
      fields: {},
      sys: {
        contentType: link("faqItem", "ContentType"),
        id: "draft",
        version: 1,
      },
    },
  ],
} satisfies Record<string, CmaResource[]>;

const fixture = (
  options: {
    contentTypeId?: string;
    field?: Partial<typeof field>;
    fields?: CmaResource["fields"];
    models?: RawContentType[];
  } = {}
) => {
  const contentTypeId = options.contentTypeId ?? "faqItem";
  const original: CmaResource = {
    fields: {
      body: { "en-US": answer },
      description: { "de-DE": answer, "en-US": answer },
      title: { "en-US": "Keep title" },
      ...options.fields,
    },
    metadata: { tags: [link("tag", "Tag")] },
    sys: {
      contentType: link(contentTypeId, "ContentType"),
      id: "faq",
      publishedVersion: 6,
      version: 7,
    },
  };
  const fake = createCmaFake({
    assets: structuredClone(references.assets),
    contentTypes: [
      contentType(contentTypeId, [
        { ...field, ...options.field },
        { ...field, id: "body" },
        { id: "image", linkType: "Asset", name: "Image", type: "Link" },
      ]),
      ...(options.models ?? []),
    ],
    // The store is mutated by saves, so assertions compare against `original`.
    entries: [
      structuredClone(original),
      ...structuredClone(references.entries),
    ],
  });
  return { fake, original };
};
/* The fields object of the nth recorded write. */
const writtenFields = (fake: ReturnType<typeof fixture>["fake"], index = 0) => {
  // SAFETY: Entry writes send a fields object; a malformed body fails the caller's equality checks.
  const { fields } = fake.writes()[index].body as {
    fields: CmaResource["fields"];
  };
  return fields;
};
const updateInput = (
  value: JsonValue = answer,
  overrides: {
    space?: string;
    fieldId?: string;
    operation?: "set" | "unset";
  } = {}
): ContentfulUpdateInput => ({
  entries: [
    {
      changes: [
        {
          fieldId: overrides.fieldId ?? "description",
          operation: overrides.operation ?? "set",
          value,
        },
      ],
      entryId: "faq",
      expectedVersion: 7,
    },
  ],
  space: overrides.space ?? "docs",
});
const createInput = (
  value: CreateValue = answer,
  overrides: {
    space?: string;
    contentTypeId?: string;
    fieldId?: string;
  } = {}
): ContentfulCreateInput => ({
  assets: null,
  contentTypeId: overrides.contentTypeId ?? "faqItem",
  fields: [{ fieldId: overrides.fieldId ?? "description", value }],
  resumeFrom: null,
  space: overrides.space ?? "docs",
});
beforeEach(() => vi.stubEnv("CONTENTFUL_MANAGEMENT_TOKEN", "test-token"));

it("updates an answer, preserving other fields, locales, metadata and publication state", async () => {
  const f = fixture();
  const replacement = doc(paragraph(text("Updated answer")));
  expect(await updateContentfulFields(updateInput(replacement))).toMatchObject({
    complete: true,
    results: [{ outcome: "updated", status: "changed" }],
  });
  const [write, ...rest] = f.fake.writes();
  expect(rest).toEqual([]);
  expect(write.url.pathname).toBe(
    `/spaces/${QUERY_SPACES.docs}/environments/master/entries/faq`
  );
  expect(write.headers.get("x-contentful-version")).toBe("7");
  expect(write.body).toEqual({
    fields: {
      ...f.original.fields,
      description: { "de-DE": answer, "en-US": replacement },
    },
    metadata: f.original.metadata,
  });
});

it("rejects setting or clearing the protected page body before any write", async () => {
  const f = fixture({
    contentTypeId: PROTECTED_BODY.contentTypeId,
    field: { id: PROTECTED_BODY.fieldId },
  });
  for await (const [value, operation] of [
    [answer, "set"],
    [null, "unset"],
  ] as const) {
    await expect(
      updateContentfulFields(
        updateInput(value, { ...PROTECTED_BODY, operation })
      )
    ).rejects.toThrow(
      "RichText writes are not supported for docs/guide/main. Edit this body with operation=patch."
    );
  }
  expect(f.fake.writes()).toHaveLength(0);
});

for (const operation of ["create", "update"] as const) {
  describe(`${operation} RichText permissions`, () => {
    it.each([
      { contentTypeId: "faqItem", fieldId: "description", space: "docs" },
      { contentTypeId: "callout", fieldId: "content", space: "docs" },
      { contentTypeId: "codeBlock", fieldId: "content", space: "docs" },
      { contentTypeId: "note", fieldId: "content", space: "site" },
      { contentTypeId: "faqItem", fieldId: "description", space: "site" },
      { contentTypeId: "component", fieldId: "main", space: "docs" },
      { contentTypeId: "blogPost", fieldId: "content", space: "docs" },
      { contentTypeId: "guide", fieldId: "main", space: "site" },
    ] as const)(
      "allows RichText outside the exact blocked scope: %j",
      async (overrides) => {
        const f = fixture({
          contentTypeId: overrides.contentTypeId,
          field: { id: overrides.fieldId },
        });
        if (operation === "create") {
          expect(
            await createContentfulEntry(createInput(answer, overrides))
          ).toMatchObject({
            outcome: "created",
            publication: "published",
          });
        } else {
          expect(
            await updateContentfulFields(updateInput(answer, overrides))
          ).toMatchObject({
            complete: true,
          });
        }
        const written = writtenFields(f.fake)[overrides.fieldId];
        if (operation === "create") {
          expect(written).toEqual({ "en-US": answer });
        } else {
          expect(written?.["en-US"]).toEqual(answer);
        }
        expect(f.fake.writes().map(({ method }) => method)).toEqual(
          operation === "create" ? ["POST", "PUT"] : ["PUT"]
        );
      }
    );
    it.each<[CreateValue, string]>([
      ["plain text", "RichText nodes must be objects."],
      [
        { content: [], nodeType: "document" },
        'Invalid RichText document: data: The property "data" is required here',
      ],
      [
        doc(text()),
        "Invalid RichText document: content.0.nodeType: Value must be one of expected values",
      ],
      [
        doc(node("unknown")),
        "Invalid RichText document: content.0.nodeType: Value must be one of expected values",
      ],
      [
        doc(paragraph({ ...text(), marks: [{ type: "unknown" }] })),
        "Unsupported RichText mark.",
      ],
      [
        doc(paragraph(node("hyperlink", [text()], {}))),
        'Invalid RichText document: content.0.content.0.data.uri: The property "uri" is required here',
      ],
      [doc(embed("bad/id")), "Invalid RichText reference ID."],
      [
        doc(
          node("embedded-resource-block", [], {
            target: {
              sys: {
                linkType: "Contentful:Entry",
                type: "ResourceLink",
                urn: "crn:contentful:::content:spaces/other/environments/master/entries/x",
              },
            },
          })
        ),
        "Cross-space RichText resource links are not supported for writes.",
      ],
    ])(
      "rejects malformed or unsupported RichText before writes: %j",
      async (value, message) => {
        const f = fixture();
        await expect(
          operation === "create"
            ? createContentfulEntry(createInput(value))
            : updateContentfulFields(updateInput(value))
        ).rejects.toThrow(`Invalid value for description: ${message}`);
        expect(f.fake.writes()).toHaveLength(0);
      }
    );
    it("rejects a missing embedded reference before writes", async () => {
      const f = fixture();
      const value = doc(embed("missing"));
      await expect(
        operation === "create"
          ? createContentfulEntry(createInput(value))
          : updateContentfulFields(updateInput(value))
      ).rejects.toThrow("was not found");
      expect(f.fake.writes()).toHaveLength(0);
    });
  });
}

it("preserves Asset-field edits on a content type whose RichText is blocked", async () => {
  const f = fixture({
    contentTypeId: "guide",
    field: { id: "main" },
    fields: { main: { "de-DE": answer, "en-US": answer } },
  });
  const completed1 = await updateContentfulFields(
    updateInput(link("image", "Asset"), { fieldId: "image" })
  );
  expect(completed1.complete).toBe(true);
  expect(f.fake.writes()).toHaveLength(1);
  expect(writtenFields(f.fake)).toEqual({
    ...f.original.fields,
    image: { "en-US": link("image", "Asset") },
  });
  expect(writtenFields(f.fake).main).toEqual({
    "de-DE": answer,
    "en-US": answer,
  });
});

it("allows a page display title while preserving its protected body", async () => {
  const f = fixture({
    contentTypeId: "blogPost",
    field: { id: "richTextTitle" },
    fields: { content: { "en-US": answer } },
  });
  expect(
    await updateContentfulFields(
      updateInput(answer, { fieldId: "richTextTitle", space: "site" })
    )
  ).toMatchObject({ complete: true });
  expect(writtenFields(f.fake)).toEqual({
    ...f.original.fields,
    richTextTitle: { "en-US": answer },
  });
});

it("allows unsetting only optional writable RichText fields", async () => {
  fixture();
  const completed2 = await updateContentfulFields(
    updateInput(null, { operation: "unset" })
  );
  expect(completed2.complete).toBe(true);
  const f = fixture({ field: { required: true } });
  await expect(
    updateContentfulFields(updateInput(null, { operation: "unset" }))
  ).rejects.toThrow("cannot be unset");
  expect(f.fake.writes()).toHaveLength(0);
});

it.each([
  {
    message:
      "Invalid value for description: Required RichText field cannot be empty.",
    restriction: { required: true },
  },
  {
    message: "Field description is disabled or omitted and cannot be written.",
    restriction: { disabled: true },
  },
  {
    message: "Field description is disabled or omitted and cannot be written.",
    restriction: { omitted: true },
  },
])(
  "honors field restrictions $restriction",
  async ({ message, restriction }) => {
    const f = fixture({ field: restriction });
    await expect(
      updateContentfulFields(updateInput(doc(paragraph(text("")))))
    ).rejects.toThrow(message);
    expect(f.fake.writes()).toHaveLength(0);
  }
);

it("checks enabled marks and nodes from the current model", () => {
  const change = {
    fieldId: "description",
    operation: "set" as const,
    value: answer,
  };
  expect(() =>
    validateUpdateChange(
      { ...field, validations: [{ enabledMarks: [] }] },
      change,
      context
    )
  ).toThrow("mark bold is disabled");
  expect(() =>
    validateUpdateChange(
      { ...field, validations: [{ enabledNodeTypes: ["paragraph"] }] },
      { ...change, value: doc(node("heading-2", [text()])) },
      context
    )
  ).toThrow("heading-2 is disabled");
});

it("checks each nested reference against its node-specific target restrictions", async () => {
  const value = doc(
    embed("same"),
    paragraph(node("entry-hyperlink", [text()], { target: link("same") }))
  );
  const f = fixture({
    field: {
      validations: [
        {
          nodes: {
            "embedded-entry-block": [{ linkContentType: ["faqItem"] }],
            "entry-hyperlink": [{ linkContentType: ["guide"] }],
          },
        },
      ],
    },
  });
  await expect(updateContentfulFields(updateInput(value))).rejects.toThrow(
    "disallowed content type"
  );
  expect(f.fake.writes()).toHaveLength(0);
});

it("deduplicates references but validates entries and assets separately", async () => {
  const f = fixture();
  const value = doc(
    embed("same"),
    embed("same"),
    embed("same", "embedded-asset-block", "Asset"),
    paragraph(
      node("asset-hyperlink", [text()], { target: link("same", "Asset") })
    )
  );
  const completed3 = await updateContentfulFields(updateInput(value));
  expect(completed3.complete).toBe(true);
  const lookups = f.fake
    .requests()
    .filter(({ url }) => url.searchParams.has("sys.id[in]"));
  const base = `/spaces/${QUERY_SPACES.docs}/environments/master`;
  expect(
    lookups
      .map(({ url }) => [url.pathname, url.searchParams.get("sys.id[in]")])
      .toSorted()
  ).toEqual([
    [`${base}/assets`, "same"],
    [`${base}/entries`, "same"],
  ]);
});

it("requires published embedded references for creation while permitting drafts in updates", async () => {
  const f = fixture();
  const value = doc(embed("draft"));
  await expect(createContentfulEntry(createInput(value))).rejects.toThrow(
    "unpublished or archived"
  );
  expect(f.fake.writes()).toHaveLength(0);
  const completed4 = await updateContentfulFields(updateInput(value));
  expect(completed4.complete).toBe(true);
});

it("applies the existing 100-reference limit to nested RichText references", async () => {
  const f = fixture();
  await expect(
    updateContentfulFields(
      updateInput(
        doc(...Array.from({ length: 101 }, (_, index) => embed(`ref-${index}`)))
      )
    )
  ).rejects.toThrow("100 distinct references");
  expect(f.fake.writes()).toHaveLength(0);
});

it("bounds document depth and node count before recursive validation", () => {
  let value = paragraph(text());
  for (let index = 0; index < 22; index += 1) {
    value = node("blockquote", [value]);
  }
  const change = {
    fieldId: "description",
    operation: "set" as const,
    value: doc(value),
  };
  expect(() => validateUpdateChange(field, change, context)).toThrow(
    "20 levels"
  );
  expect(() =>
    validateUpdateChange(
      field,
      {
        ...change,
        value: doc(...Array.from({ length: 1000 }, () => paragraph(text()))),
      },
      context
    )
  ).toThrow("1,000 nodes");
});

it("accepts ordinary paragraphs, lists, hyperlinks and tables with implicit structural nodes", async () => {
  const f = fixture({
    field: {
      validations: [
        {
          enabledMarks: ["bold"],
          enabledNodeTypes: ["unordered-list", "hyperlink", "table"],
        },
      ],
    },
  });
  const value = doc(
    paragraph(
      text("Answer", ["bold"]),
      node("hyperlink", [text("Documentation")], {
        uri: "https://example.com/docs",
      })
    ),
    node("unordered-list", [node("list-item", [paragraph(text("First"))])]),
    node("table", [
      node("table-row", [node("table-cell", [paragraph(text("Cell"))])]),
    ])
  );
  const completed5 = await updateContentfulFields(updateInput(value));
  expect(completed5.complete).toBe(true);
  expect(writtenFields(f.fake).description?.["en-US"]).toEqual(value);
});

it.each([{ min: 1 }, { max: 0 }])(
  "enforces model reference counts %j",
  (size) => {
    const value = size.min ? answer : doc(embed("one"));
    expect(() =>
      validateUpdateChange(
        {
          ...field,
          validations: [{ nodes: { "embedded-entry-block": [{ size }] } }],
        },
        { fieldId: "description", operation: "set", value },
        context
      )
    ).toThrow("reference count");
  }
);

it("does not create assets from placeholders nested in RichText", async () => {
  const f = fixture();
  await expect(
    updateContentfulFields(
      updateInput(
        doc(
          node("embedded-asset-block", [], { target: { newAsset: "picture" } })
        )
      )
    )
  ).rejects.toThrow("Invalid RichText");
  expect(f.fake.writes()).toHaveLength(0);
});

it("blocks the whole update batch before writing an allowed answer when another field is forbidden", async () => {
  const f = fixture({
    models: [contentType("guide", [{ ...field, id: "main" }])],
  });
  f.fake.entries.set("second", {
    ...structuredClone(f.original),
    sys: {
      ...f.original.sys,
      contentType: link("guide", "ContentType"),
      id: "second",
    },
  });
  const input = updateInput();
  input.entries.push({
    ...input.entries[0],
    changes: [{ fieldId: "main", operation: "set", value: answer }],
    entryId: "second",
  });
  await expect(updateContentfulFields(input)).rejects.toThrow(
    "RichText writes are not supported for docs/guide/main."
  );
  expect(f.fake.writes()).toHaveLength(0);
});

it("rejects an unexpected model identity before saving", async () => {
  const f = fixture();
  f.fake.intercept(
    ({ collection }) => collection === "content_types",
    () => Response.json(contentType("other", [field]))
  );
  await expect(updateContentfulFields(updateInput())).rejects.toThrow(
    "different content type"
  );
  expect(f.fake.writes()).toHaveLength(0);
});
