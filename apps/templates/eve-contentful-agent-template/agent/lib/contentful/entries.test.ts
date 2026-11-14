import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject, JsonValue } from "../json";
import { getEntry, parseEntryUrl, readEntryContent } from "./entries";
import { link } from "./testing/cma";
import type { Collection, RawAsset, RawEntry, RawSys } from "./types";

const SITE = "sample-site";
const url =
  "https://app.contentful.com/spaces/sample-site/environments/master/entries/example";
const submissionUrl = `https://app.contentful.com/spaces/${SITE}/environments/master/entries/submission`;
const localized = (fields: JsonObject) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, { "en-US": value }])
  );

const stubFetch = (handler: (url: URL) => Response) => {
  const request = vi.fn((input: URL, _init: RequestInit) =>
    Promise.resolve(handler(new URL(String(input))))
  );
  vi.stubGlobal("fetch", request);
  return request;
};

const unexpected = (path: URL): never => {
  throw new Error(`Unexpected request ${path.pathname}${path.search}`);
};

const relatedEntry = {
  fields: { title: { "en-US": "Related article" } },
  sys: { contentType: link("blogPost", "ContentType"), id: "related" },
} satisfies RawEntry;
const diagramAsset = {
  fields: {
    file: { "en-US": { url: "//images.example.com/diagram.png" } },
    title: { "en-US": "Diagram" },
  },
  sys: { id: "image" },
} satisfies RawAsset;

const mockEntry = (fields: JsonObject) =>
  stubFetch((path) => {
    const base = "/spaces/sample-site/environments/master";
    const ids = path.searchParams.get("sys.id[in]");
    if (path.pathname === `${base}/entries/example`) {
      return Response.json({
        fields: localized(fields),
        sys: {
          contentType: link("blogPost", "ContentType"),
          id: "example",
          version: 7,
        },
      } satisfies RawEntry);
    }
    if (path.pathname === `${base}/assets` && ids === "image") {
      return Response.json({
        items: [diagramAsset],
      } satisfies Collection<RawAsset>);
    }
    if (path.pathname === `${base}/entries` && ids === "related") {
      return Response.json({
        items: [relatedEntry],
      } satisfies Collection<RawEntry>);
    }
    return unexpected(path);
  });

const pageEntry = (
  id: string,
  fields: JsonObject = {},
  sys: Partial<RawSys> = {}
) =>
  ({
    fields: localized({
      content: "Watering details",
      slug: id,
      title: id,
      ...fields,
    }),
    sys: {
      contentType: link("blogPost", "ContentType"),
      id,
      publishedVersion: 1,
      updatedAt: "2026-01-01",
      version: 2,
      ...sys,
    },
  }) satisfies RawEntry;

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));

describe("Contentful entry URL parsing", () => {
  it.each([
    [
      "https://example.com/help/guide/repot-a-fern",
      { page: "helpGuide", slug: "repot-a-fern" },
    ],
    [
      "https://example.com/help/watering",
      { page: "helpTopic", slug: "watering" },
    ],
    ["https://example.com/blog/my-post", { page: "blog", slug: "my-post" }],
    ["https://example.com/news/new-thing", { page: "news", slug: "new-thing" }],
    ["https://example.com/p/about-us", { page: "page", slug: "about-us" }],
    [
      "  https://EXAMPLE.COM/Blog/My-Post/?utm=x#top  ",
      { page: "blog", slug: "my-post" },
    ],
  ])("routes %s by slug", (input, expected) => {
    expect(parseEntryUrl(input)).toEqual({
      kind: "slug",
      ...expected,
    });
  });

  it.each([
    "http://example.com/blog/my-post",
    "https://unconfigured.example/blog/my-post",
    "https://example.com/blog/2026/my-post",
    "https://example.com/docs/my-post",
    "https://example.com/blog/my_post",
    "https://example.com/blog/-post",
    "not a url",
  ])("rejects %s", (input) => {
    expect(parseEntryUrl(input)).toBeNull();
  });

  it("reads Contentful web-app links, defaulting to the master environment", () => {
    expect(
      parseEntryUrl("https://app.contentful.com/spaces/abc/entries/xyz")
    ).toEqual({
      entryId: "xyz",
      environmentId: "master",
      kind: "id",
      spaceId: "abc",
    });
    expect(parseEntryUrl(url)).toEqual({
      entryId: "example",
      environmentId: "master",
      kind: "id",
      spaceId: "sample-site",
    });
  });
});

const slugEntry = (id: string, sys: Partial<RawSys>) =>
  ({
    fields: localized({ slug: "my-post", title: id }),
    sys: {
      contentType: link("blogPost", "ContentType"),
      id,
      version: 3,
      ...sys,
    },
  }) satisfies RawEntry;

describe("Contentful slug resolution", () => {
  it("prefers a published match, then the most recent update, and reports the rest as duplicates", async () => {
    const request = stubFetch((path) =>
      path.searchParams.get("fields.slug") === "my-post"
        ? Response.json({
            items: [
              slugEntry("newer-draft", { updatedAt: "2026-09-01T00:00:00Z" }),
              slugEntry("older-live", {
                publishedVersion: 1,
                updatedAt: "2026-01-01T00:00:00Z",
              }),
              slugEntry("newer-live", {
                publishedVersion: 2,
                updatedAt: "2026-06-01T00:00:00Z",
              }),
            ],
          } satisfies Collection<RawEntry>)
        : unexpected(path)
    );
    const result = await getEntry("https://example.com/blog/my-post");
    expect(result).toMatchObject({
      duplicates: ["older-live", "newer-draft"],
      entryId: "newer-live",
      page: "blog",
      spaceId: SITE,
    });
    const lookup = new URL(String(request.mock.calls[0][0]));
    expect(lookup.pathname).toBe(`/spaces/${SITE}/environments/master/entries`);
    expect(Object.fromEntries(lookup.searchParams)).toEqual({
      content_type: "blogPost",
      "fields.slug": "my-post",
      limit: "10",
    });
  });

  it("reports a missing slug instead of guessing", async () => {
    stubFetch(() => Response.json({ items: [] }));
    await expect(getEntry("https://example.com/blog/my-post")).rejects.toThrow(
      'No blog entry with slug "my-post" was found in Contentful.'
    );
  });
});

describe("Contentful entry normalization", () => {
  it("returns the current version without a separate lookup", async () => {
    const request = mockEntry({ title: "Guide" });
    expect(await getEntry(url)).toMatchObject({
      entryId: "example",
      version: 7,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("resolves embedded entries, assets, and hyperlink targets inside rich text", async () => {
    const request = mockEntry({
      content: {
        content: [
          {
            data: { target: link("related") },
            nodeType: "embedded-entry-block",
          },
          {
            data: { target: link("image", "Asset") },
            nodeType: "embedded-asset-block",
          },
          {
            content: [
              {
                content: [{ nodeType: "text", value: "Read more" }],
                data: { target: link("related") },
                nodeType: "entry-hyperlink",
              },
            ],
            nodeType: "paragraph",
          },
        ],
        nodeType: "document",
      },
      related: [link("related")],
    });
    const result = await getEntry(url);
    expect(result.linked).toEqual([
      {
        contentType: "blogPost",
        id: "related",
        title: "Related article",
        type: "Entry",
      },
      {
        id: "image",
        title: "Diagram",
        type: "Asset",
        url: "https://images.example.com/diagram.png",
      },
    ]);
    expect(result.fields.related).toEqual([result.linked[0]]);
    expect(
      request.mock.calls.map(([input]) => {
        const requested = new URL(String(input));
        return [requested.pathname, requested.searchParams.get("sys.id[in]")];
      })
    ).toEqual([
      ["/spaces/sample-site/environments/master/entries/example", null],
      ["/spaces/sample-site/environments/master/entries", "related"],
      ["/spaces/sample-site/environments/master/assets", "image"],
    ]);
  });

  it("resolves a reference that exists only inside rich text", async () => {
    const request = mockEntry({
      content: {
        content: [
          {
            data: { target: link("related") },
            nodeType: "embedded-entry-inline",
          },
        ],
        nodeType: "document",
      },
    });
    const result = await getEntry(url);
    expect(result.linked).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clips large nested JSON strings and marks truncation", async () => {
    mockEntry({
      structured: {
        count: 2,
        empty: null,
        enabled: true,
        nested: [{ text: "x".repeat(100_000) }],
      },
    });
    const result = await getEntry(url);
    // SAFETY: The fixture defines this nested object; the test verifies that rendering preserves its shape while clipping strings.
    const structured = result.fields.structured as {
      nested: { text: string }[];
    };
    expect(structured.nested[0].text.length).toBe(20_000);
    expect(structured.nested[0].text.endsWith("…[truncated]")).toBe(true);
    expect(result.fields.structured).toMatchObject({
      count: 2,
      empty: null,
      enabled: true,
    });
    expect(result.truncated).toBe(true);
  });

  it("shares the total text budget across nested objects, arrays, and fields", async () => {
    mockEntry({
      final: "Tail",
      nested: { values: Array.from({ length: 5 }, () => "b".repeat(20_000)) },
      text: "a".repeat(20_000),
    });
    const result = await getEntry(url);
    // SAFETY: The fixture supplies nested.values as strings; this test verifies their shared truncation budget.
    const nested = result.fields.nested as { values: string[] };
    const strings = [
      // SAFETY: The fixture supplies a string text field, whose rendered length is asserted below.
      result.fields.text as string,
      ...nested.values,
      // SAFETY: The fixture supplies a string final field, which may be clipped to an empty string.
      result.fields.final as string,
    ];
    expect(strings.reduce((length, value) => length + value.length, 0)).toBe(
      80_000
    );
    expect(strings.some((value) => value === "")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("preserves small nested objects without marking truncation", async () => {
    const fields = {
      structured: { count: 1, sections: [{ body: "World", title: "Hello" }] },
    };
    mockEntry(fields);
    const result = await getEntry(url);
    expect(result.fields).toEqual(fields);
    expect(result.truncated).toBe(false);
  });
});

const buildCursor = (fields: JsonObject) =>
  Buffer.from(
    JSON.stringify({
      entryKey: `${SITE}/master/submission`,
      offset: 0,
      section: 1000,
      version: 2,
      ...fields,
    })
  ).toString("base64url");

describe("version-pinned Contentful reading", () => {
  it("skips empty rich text at a page boundary so continuation remains valid", async () => {
    stubFetch(() =>
      Response.json({
        fields: {
          content: { "en-US": "x".repeat(12_000) },
          empty: { "en-US": { content: [], nodeType: "document" } },
          ending: { "en-US": "Last paragraph" },
        },
        sys: { id: "submission", version: 2 },
      })
    );
    const first = await readEntryContent(submissionUrl, null);
    const second = await readEntryContent(submissionUrl, first.nextCursor);
    expect(second.sections).toEqual([
      { end: 14, field: "/ending", start: 0, text: "Last paragraph" },
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("reconstructs long nested text over multiple pages with exact field offsets", async () => {
    const body = `${"a".repeat(25_000)}final paragraph`;
    stubFetch(() =>
      Response.json(pageEntry("submission", { content: { "a/b~c": [body] } }))
    );

    let cursor: string | null = null;
    let recovered = "";
    let pages = 0;
    for await (const _page of Array.from({ length: 10 })) {
      const result = await readEntryContent(submissionUrl, cursor);
      expect(
        result.sections.reduce((sum, section) => sum + section.text.length, 0)
      ).toBeLessThanOrEqual(12_000);
      for (const section of result.sections.filter(
        ({ field }) => field === "/content/a~1b~0c/0"
      )) {
        expect(section.start).toBe(recovered.length);
        recovered += section.text;
        expect(section.end).toBe(recovered.length);
      }
      cursor = result.nextCursor;
      pages += 1;
      if (!cursor) {
        break;
      }
    }
    expect(recovered).toBe(body);
    expect(pages).toBe(3);
  });

  it("returns rich-text headings and embedded entry links without inventing their bodies", async () => {
    stubFetch(() =>
      Response.json(
        pageEntry("submission", {
          content: {
            content: [
              {
                content: [{ nodeType: "text", value: "Configuration" }],
                nodeType: "heading-2",
              },
              {
                data: {
                  target: {
                    sys: { id: "embedded", linkType: "Entry", type: "Link" },
                  },
                },
                nodeType: "embedded-entry-block",
              },
            ],
            nodeType: "document",
          },
        })
      )
    );
    const result = await readEntryContent(submissionUrl, null);
    expect(
      result.sections.find(({ field }) => field === "/content")?.text
    ).toContain("Configuration");
    expect(result.linked).toContainEqual({
      contentfulUrl: submissionUrl.replace("submission", "embedded"),
      id: "embedded",
      type: "Entry",
    });
    expect(result.version).toBe(2);
    expect(result.status).toBe("published");
  });

  it("returns each top-level rich-text block with its index and hash", async () => {
    const blocks = [
      {
        content: [{ nodeType: "text", value: "Configuration" }],
        data: {},
        nodeType: "heading-2",
      },
      { content: [], data: {}, nodeType: "paragraph" },
      {
        content: [{ nodeType: "text", value: "Run the CLI." }],
        data: {},
        nodeType: "paragraph",
      },
    ];
    stubFetch(() =>
      Response.json(
        pageEntry("submission", {
          content: { content: blocks, data: {}, nodeType: "document" },
        })
      )
    );
    const result = await readEntryContent(submissionUrl, null);

    // Pinned 12-character SHA-256 prefixes of each block's JSON, so a change to
    // the hashing contract used by block patches fails here.
    expect(result.sections.filter(({ field }) => field === "/content")).toEqual(
      [
        {
          block: { hash: "2e9815a0fbcc", index: 0, nodeType: "heading-2" },
          end: 13,
          field: "/content",
          start: 0,
          text: "Configuration",
        },
        {
          block: { hash: "1f98c2485e6e", index: 1, nodeType: "paragraph" },
          end: 17,
          field: "/content",
          start: 0,
          text: "[empty paragraph]",
        },
        {
          block: { hash: "3adeee531734", index: 2, nodeType: "paragraph" },
          end: 12,
          field: "/content",
          start: 0,
          text: "Run the CLI.",
        },
      ]
    );
  });

  it("keeps raw rich-text blocks whole across pages when JSON is requested", async () => {
    const blocks = ["a", "b", "c"].map((letter) => ({
      content: [
        { data: {}, marks: [], nodeType: "text", value: letter.repeat(5000) },
      ],
      data: {},
      nodeType: "paragraph",
    }));
    stubFetch(() =>
      Response.json(
        pageEntry("submission", {
          content: { content: blocks, data: {}, nodeType: "document" },
        })
      )
    );
    const pages: { block?: { index: number; json?: JsonValue } }[][] = [];
    let cursor: string | null = null;
    for await (const _page of Array.from({ length: 10 })) {
      const result = await readEntryContent(submissionUrl, cursor, undefined, {
        richTextJson: true,
      });
      pages.push(result.sections.filter(({ block }) => block));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }
    expect(pages.map((page) => page.map(({ block }) => block?.index))).toEqual([
      [0],
      [1],
      [2],
    ]);
    expect(pages.flat().map(({ block }) => block?.json)).toEqual(blocks);
  });

  it("requires restarting if the entry version changes between pages", async () => {
    let version = 2;
    stubFetch(() =>
      Response.json(
        pageEntry("submission", { content: "x".repeat(20_000) }, { version })
      )
    );
    const first = await readEntryContent(submissionUrl, null);
    version += 1;
    await expect(
      readEntryContent(submissionUrl, first.nextCursor)
    ).rejects.toThrow("Discard earlier pages");
    const completed1 = await readEntryContent(submissionUrl, null);
    expect(completed1.version).toBe(3);
  });

  it("rejects a cursor for an unconfigured environment, another entry, or malformed cursors", async () => {
    stubFetch((path) =>
      Response.json(
        path.pathname.endsWith("/entries/example")
          ? pageEntry("example", { content: "y".repeat(20_000) })
          : pageEntry("submission", { content: "x".repeat(20_000) })
      )
    );
    const first = await readEntryContent(submissionUrl, null);
    await expect(
      readEntryContent(
        submissionUrl.replace("master", "staging"),
        first.nextCursor
      )
    ).rejects.toThrow("Environment is not configured");
    // Same space, environment, and version; only the entry identity differs.
    await expect(readEntryContent(url, first.nextCursor)).rejects.toThrow(
      "Discard earlier pages"
    );
    await expect(readEntryContent(submissionUrl, "garbage")).rejects.toThrow(
      "Invalid content cursor"
    );
    await expect(
      readEntryContent(submissionUrl, buildCursor({ mode: "text" }))
    ).rejects.toThrow("out of range");
    await expect(
      readEntryContent(
        submissionUrl,
        buildCursor({ mode: "text", offset: 99_999, section: 0 })
      )
    ).rejects.toThrow("out of range");
    // Cursors from before block sections have no mode and must restart.
    await expect(
      readEntryContent(submissionUrl, buildCursor({ section: 0 }))
    ).rejects.toThrow("Invalid content cursor");
    await expect(
      readEntryContent(submissionUrl, first.nextCursor, undefined, {
        richTextJson: true,
      })
    ).rejects.toThrow("different richTextJson setting");
  });

  it("refuses unversioned reads and finishes an entry with no fields", async () => {
    stubFetch(() =>
      Response.json(pageEntry("submission", {}, { version: undefined }))
    );
    await expect(readEntryContent(submissionUrl, null)).rejects.toThrow(
      "entry version"
    );
    stubFetch(() =>
      Response.json({ fields: {}, sys: { id: "submission", version: 1 } })
    );
    expect(await readEntryContent(submissionUrl, null)).toMatchObject({
      linked: [],
      nextCursor: null,
      sections: [],
    });
  });
});

describe("resource-kind reference identity", () => {
  it.each([false, true])(
    "retains same-ID Entry and Asset metadata with reversed order %s",
    async (reverse) => {
      const fields = {
        nested: [link("shared"), link("shared", "Asset"), link("shared")],
      };
      if (reverse) {
        fields.nested = [
          link("shared", "Asset"),
          link("shared"),
          link("shared"),
        ];
      }
      const fetch = stubFetch((path) => {
        if (path.pathname.endsWith("/entries/example")) {
          return Response.json(pageEntry("example", fields));
        }
        if (path.pathname.endsWith("/entries")) {
          return Response.json({
            items: [
              { ...relatedEntry, sys: { ...relatedEntry.sys, id: "shared" } },
            ],
          });
        }
        if (path.pathname.endsWith("/assets")) {
          return Response.json({
            items: [{ ...diagramAsset, sys: { id: "shared" } }],
          });
        }
        return unexpected(path);
      });
      const result = await getEntry(url);
      expect(result.linked).toEqual([
        {
          contentType: "blogPost",
          id: "shared",
          title: "Related article",
          type: "Entry",
        },
        {
          id: "shared",
          title: "Diagram",
          type: "Asset",
          url: "https://images.example.com/diagram.png",
        },
      ]);
      expect(result.fields.nested).toEqual(
        reverse
          ? [result.linked[1], result.linked[0], result.linked[0]]
          : [result.linked[0], result.linked[1], result.linked[0]]
      );
      expect(fetch).toHaveBeenCalledTimes(3);
      const content = await readEntryContent(url, null);
      expect(content.linked.map(({ type }) => type)).toEqual(
        reverse ? ["Asset", "Entry"] : ["Entry", "Asset"]
      );
    }
  );

  it("keeps the missing Entry placeholder when same-ID Asset metadata resolves", async () => {
    stubFetch((path) => {
      if (path.pathname.endsWith("/entries/example")) {
        return Response.json(
          pageEntry("example", {
            author: link("shared"),
            image: link("shared", "Asset"),
          })
        );
      }
      if (path.pathname.endsWith("/entries")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        items: [{ ...diagramAsset, sys: { id: "shared" } }],
      });
    });
    const result = await getEntry(url);
    expect(result.fields.author).toEqual({
      id: "shared",
      title: null,
      type: "Entry",
    });
    expect(result.fields.image).toMatchObject({
      title: "Diagram",
      type: "Asset",
    });
  });
});
