import { describe, expect, it, vi } from "vitest";

import { richTextBlockHash } from "./content";
import { prepareCreation } from "./create";
import { getEntry, readEntryContent } from "./entries";
import { contentLocale, fieldLocale, withContentfulLocale } from "./locale";
import { runContentfulQuery } from "./query";
import { contentType, createCmaFake, link } from "./testing/cma";
import type { CmaResource } from "./testing/cma";
import { prepareUpdate } from "./update";

const url = "https://app.contentful.com/spaces/sample-docs/entries/example";
const block = {
  content: [
    { data: {}, marks: [], nodeType: "text", value: "Shared paragraph" },
  ],
  data: {},
  nodeType: "paragraph",
};
const document = { content: [block], data: {}, nodeType: "document" };
const fixture = (defaultLocale = "en-US") => {
  vi.stubEnv("CONTENTFUL_LOCALE", "fr-FR");
  const entry: CmaResource = {
    fields: {
      body: { [defaultLocale]: document },
      missing: { [defaultLocale]: "No French translation" },
      refs: { [defaultLocale]: [link("author")] },
      slug: { [defaultLocale]: "shared-slug" },
      title: { [defaultLocale]: "Default title", "fr-FR": "French title" },
    },
    sys: {
      contentType: link("guide", "ContentType"),
      id: "example",
      version: 7,
    },
  };
  const fake = createCmaFake({
    contentTypes: [
      contentType("guide", [
        { id: "title", localized: true, name: "Title", type: "Symbol" },
        { id: "slug", localized: false, name: "Slug", type: "Symbol" },
        { id: "missing", localized: true, name: "Missing", type: "Symbol" },
        { id: "body", localized: false, name: "Body", type: "RichText" },
        {
          id: "refs",
          items: { linkType: "Entry", type: "Link" },
          localized: false,
          name: "References",
          type: "Array",
        },
      ]),
      contentType("author", [
        { id: "name", localized: false, name: "Name", type: "Symbol" },
      ]),
    ],
    defaultLocale,
    entries: [
      entry,
      {
        fields: { name: { [defaultLocale]: "Shared author" } },
        sys: {
          contentType: link("author", "ContentType"),
          id: "author",
          publishedVersion: 1,
          version: 2,
        },
      },
    ],
  });
  return { entry, fake };
};

const patchChange = (hash: string) => ({
  changes: [
    {
      fieldId: "body",
      operation: "patch" as const,
      value: {
        edits: [
          {
            find: "Shared",
            hash,
            index: 0,
            replace: "Updated",
            type: "replaceText",
          },
        ],
        embeds: null,
      },
    },
  ],
  entryId: "example",
  expectedVersion: 7,
});

describe("Contentful field locale selection", () => {
  it.each(["en-US", "de-DE"])(
    "reads shared fields and references with %s as default, without translation fallback",
    async (defaultLocale) => {
      const { entry, fake } = fixture(defaultLocale);
      const result = await withContentfulLocale("docs", () => getEntry(url));
      expect(result.fields).toMatchObject({
        body: "Shared paragraph",
        refs: [{ title: "Shared author", type: "Entry" }],
        slug: "shared-slug",
        title: "French title",
      });
      expect(result.fields).not.toHaveProperty("missing");
      expect(entry.fields.slug).toEqual({ [defaultLocale]: "shared-slug" });
      const content = await withContentfulLocale("docs", () =>
        readEntryContent(url, null, undefined, { richTextJson: true })
      );
      expect(content.sections).toContainEqual(
        expect.objectContaining({ field: "/body", text: "Shared paragraph" })
      );
      expect(content.linked).toContainEqual(
        expect.objectContaining({ id: "author", type: "Entry" })
      );
      expect(fake.writes()).toEqual([]);
    }
  );

  it("creates shared fields in the default locale and translated fields in the selected locale", async () => {
    const { fake } = fixture("de-DE");
    const result = await withContentfulLocale("docs", () =>
      prepareCreation({
        assets: null,
        contentTypeId: "guide",
        fields: [
          { fieldId: "slug", value: "new-slug" },
          { fieldId: "title", value: "Titre" },
        ],
        resumeFrom: null,
        space: "docs",
      })
    );
    expect(result.fields).toEqual({
      slug: { "de-DE": "new-slug" },
      title: { "fr-FR": "Titre" },
    });
    expect(fake.writes()).toEqual([]);
  });

  it.each(["set", "unset"] as const)(
    "prepares shared-field %s without touching translations",
    async (operation) => {
      const { fake } = fixture("de-DE");
      const result = await withContentfulLocale("docs", () =>
        prepareUpdate("docs", {
          changes: [
            {
              fieldId: "slug",
              operation,
              value: operation === "set" ? "new-slug" : null,
            },
            { fieldId: "title", operation: "set", value: "Titre" },
          ],
          entryId: "example",
          expectedVersion: 7,
        })
      );
      const body = JSON.parse(result.body);
      expect(body.fields.slug).toEqual(
        operation === "set" ? { "de-DE": "new-slug" } : {}
      );
      expect(body.fields.title).toEqual({
        "de-DE": "Default title",
        "fr-FR": "Titre",
      });
      expect(body.fields.missing).toEqual({ "de-DE": "No French translation" });
      expect(fake.writes()).toEqual([]);
    }
  );

  it("patches shared RichText at its default locale and rejects stale block hashes", async () => {
    const { fake } = fixture("de-DE");
    const result = await withContentfulLocale("docs", () =>
      prepareUpdate("docs", patchChange(richTextBlockHash(block)))
    );
    expect(JSON.parse(result.body).fields.body).toEqual({
      "de-DE": {
        ...document,
        content: [
          {
            ...block,
            content: [{ ...block.content[0], value: "Updated paragraph" }],
          },
        ],
      },
    });
    await expect(
      withContentfulLocale("docs", () =>
        prepareUpdate("docs", patchChange("000000000000"))
      )
    ).rejects.toThrow(
      "Block 0 does not match its hash. Read the entry again and use the current block indexes and hashes."
    );
    expect(fake.writes()).toEqual([]);
  });

  it("projects shared query fields and references while keeping missing translations absent", async () => {
    const { entry, fake } = fixture();
    fake.intercept(
      (request) => request.collection === "entries" && request.id === null,
      () => Response.json({ items: [entry], total: 1 })
    );
    const query = {
      includeArchived: null,
      limit: null,
      parameters: [{ name: "select", value: "sys,fields" }],
      resolveUsers: null,
      resultMode: "references" as const,
      skip: null,
      space: "docs",
    };
    const result = await withContentfulLocale("docs", () =>
      runContentfulQuery(query)
    );
    expect(result.entries[0].fields).toEqual({
      slug: "shared-slug",
      title: "French title",
    });
    expect(result.entries[0].references).toContainEqual(
      expect.objectContaining({ id: "author" })
    );
    expect(result.entries[0].referenceCoverage?.scannedFields).not.toContain(
      "/missing"
    );
  });

  it("isolates default locales when concurrent spaces share an override", async () => {
    const { fake } = fixture();
    fake.intercept(
      (request) => request.url.pathname.endsWith("/locales"),
      (request) =>
        Response.json({
          items: [
            {
              code: request.url.pathname.includes("sample-docs")
                ? "de-DE"
                : "ja-JP",
              default: true,
            },
          ],
        })
    );
    const results = await Promise.all(
      ["docs", "site"].map((space) =>
        withContentfulLocale(space, async () => {
          await Promise.resolve();
          return [
            contentLocale(),
            fieldLocale({ localized: false }),
            fieldLocale({ localized: true }),
          ];
        })
      )
    );
    expect(results).toEqual([
      ["fr-FR", "de-DE", "fr-FR"],
      ["fr-FR", "ja-JP", "fr-FR"],
    ]);
  });
});
