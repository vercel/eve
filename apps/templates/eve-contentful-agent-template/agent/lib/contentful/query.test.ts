import { describe, expect, it, vi } from "vitest";

import type { JsonObject, JsonValue } from "../json";
import { contentfulQueryInputSchema } from "./input-schemas";
import { runContentfulQuery } from "./query";
import { link } from "./testing/cma";
import type { RawQueryEntry, RawSys } from "./types";

const queryInput = {
  includeArchived: null,
  limit: null,
  // SAFETY: The empty fixture array is widened to the parameter records added by later test cases.
  parameters: [] as { name: string; value: string }[],
  resolveUsers: null,
  resultMode: null,
  skip: null,
  space: "site" as const,
};
const contentType = (id: string) => ({
  sys: { id, linkType: "ContentType", type: "Link" as const },
});

const entry = (
  id: string,
  fields: JsonObject = {},
  sys: Partial<RawSys> = {}
) =>
  ({
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { "en-US": value }])
    ),
    sys: { contentType: contentType("customType"), id, version: 1, ...sys },
  }) satisfies RawQueryEntry;

const mockResponse = (body: JsonValue, status = 200) => {
  const request = vi.fn((_url: URL, _init: RequestInit): Promise<Response> =>
    Promise.resolve(Response.json(body, { status }))
  );
  vi.stubGlobal("fetch", request);
  return request;
};

const requestedUrl = (request: ReturnType<typeof mockResponse>) =>
  new URL(String(request.mock.calls[0][0]));

describe("custom Contentful queries", () => {
  it.each([
    ["docs", "sample-docs"],
    ["site", "sample-site"],
  ] as const)(
    "uses only the configured %s GET endpoint and retains draft content",
    async (space, spaceId) => {
      const request = mockResponse({
        items: [entry("draft", { label: "Custom title" })],
        total: 1,
      });
      const result = await runContentfulQuery({ ...queryInput, space });
      const url = requestedUrl(request);
      expect(url.origin).toBe("https://api.contentful.com");
      expect(url.pathname).toBe(
        `/spaces/${spaceId}/environments/master/entries`
      );
      expect(request.mock.calls[0][1].method).toBe("GET");
      expect(result.effectiveParameters).toEqual({
        limit: "25",
        order: "sys.id",
        select: "sys,fields._displayField",
        skip: "0",
        "sys.archivedAt[exists]": "false",
      });
      expect(result.entries[0]).toMatchObject({
        contentTypeId: "customType",
        fields: { label: "Custom title" },
        status: "draft",
        version: 1,
      });
      expect(result.entries[0].contentfulUrl).toContain(
        `/spaces/${spaceId}/environments/master/entries/draft`
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it("passes native audit filters and selection with correct URL encoding", async () => {
    const request = mockResponse({ items: [entry("one")], total: 100 });
    const parameters = Object.entries({
      content_type: "customType",
      "fields.category.sys.id": "category",
      "fields.date[gte]": "2026-01-01",
      "fields.date[lt]": "2026-09-01",
      "fields.description[exists]": "false",
      links_to_asset: "image",
      links_to_entry: "related",
      "metadata.tags.sys.id[all]": "one,two",
      order: "-fields.date,sys.id",
      query: "a&access_token=fake # + unicode é",
      select: "sys.id,fields.label,metadata.tags",
      "sys.updatedAt[lt]": "2026-03-01",
    }).map(([name, value]) => ({ name, value }));
    const result = await runContentfulQuery({
      ...queryInput,
      limit: 1,
      parameters,
      skip: 2,
    });
    const url = requestedUrl(request);
    for (const { name, value } of parameters.filter(
      (parameter) => parameter.name !== "select"
    )) {
      expect(url.searchParams.get(name)).toBe(value);
    }
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(url.searchParams.get("select")).toBe(
      "sys,fields.label,metadata.tags"
    );
    expect(result).toMatchObject({
      limit: 1,
      nextSkip: 3,
      skip: 2,
      total: 100,
    });
  });

  it("distinguishes first publication from republishing and subsequent edits", async () => {
    mockResponse({
      items: [
        entry(
          "changed",
          {},
          {
            firstPublishedAt: "2026-09-01T10:00:00Z",
            publishedAt: "2026-09-09T10:00:00Z",
            publishedVersion: 3,
            updatedAt: "2026-09-10T10:00:00Z",
            version: 5,
          }
        ),
        entry("draft"),
      ],
      total: 2,
    });
    const result = await runContentfulQuery(queryInput);
    expect(result.entries[0]).toMatchObject({
      firstPublishedAt: "2026-09-01T10:00:00Z",
      publishedAt: "2026-09-09T10:00:00Z",
      status: "changed",
      updatedAt: "2026-09-10T10:00:00Z",
    });
    expect(result.entries[1].firstPublishedAt).toBeNull();
  });

  it("preserves selected JSON, booleans, nulls, arrays and links without resolving them", async () => {
    const fields = {
      author: link("person"),
      body: { content: [], nodeType: "document" },
      count: 0,
      enabled: false,
      label: "Title",
      nullable: null,
      settings: { nested: true },
      tags: ["a"],
    };
    const raw = { ...entry("one", fields), metadata: { tags: [link("tag")] } };
    Object.assign(raw.fields, { frenchOnly: { "fr-FR": "Texte" } });
    const request = mockResponse({ items: [raw], total: 1 });
    const result = await runContentfulQuery({
      ...queryInput,
      parameters: [{ name: "select", value: "fields,metadata" }],
    });
    expect(result.entries[0].fields).toEqual(fields);
    expect(result.entries[0].metadata).toEqual(raw.metadata);
    expect(result.entries[0].truncatedFields).toEqual([]);
    expect(result.nextSkip).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns all states and keeps explicit archive filters when inclusion is enabled", async () => {
    mockResponse({
      items: [
        entry("draft"),
        entry("published", {}, { publishedVersion: 1, version: 2 }),
        entry("changed", {}, { publishedVersion: 1, version: 3 }),
        entry("archived", {}, { archivedVersion: 1 }),
      ],
      total: 4,
    });
    const result = await runContentfulQuery({
      ...queryInput,
      includeArchived: true,
    });
    expect(result.entries.map((item) => item.status)).toEqual([
      "draft",
      "published",
      "changed",
      "archived",
    ]);
    expect(result.effectiveParameters).not.toHaveProperty(
      "sys.archivedAt[exists]"
    );
    const archived = await runContentfulQuery({
      ...queryInput,
      includeArchived: true,
      parameters: [{ name: "sys.archivedAt[exists]", value: "true" }],
    });
    expect(archived.effectiveParameters["sys.archivedAt[exists]"]).toBe("true");
  });

  it("requires explicit archive inclusion instead of overriding a conflicting filter", async () => {
    const request = mockResponse({});
    await expect(
      runContentfulQuery({
        ...queryInput,
        parameters: [{ name: "sys.archivedAt[exists]", value: "true" }],
      })
    ).rejects.toThrow("includeArchived");
    expect(request).not.toHaveBeenCalled();
  });

  it("shares the serialized field budget across entries and distinguishes omissions from absence", async () => {
    mockResponse({
      items: [
        entry("one", { fits: '\\"'.repeat(3000), huge: "x".repeat(20_001) }),
        entry("two", { small: 0, tooLarge: "y".repeat(9000) }),
        {
          ...entry("three"),
          // A field with no default-locale value is absent, not omitted.
          fields: { absentLocale: { "fr-FR": "ignored" } },
          metadata: { large: "z".repeat(20_000) },
        },
      ],
      total: 90,
    });
    const result = await runContentfulQuery(queryInput);
    const size = result.entries.reduce(
      (total, item) =>
        total +
        JSON.stringify(item.fields).length +
        (item.metadata ? JSON.stringify(item.metadata).length : 0),
      0
    );
    expect(size).toBeLessThanOrEqual(20_000);
    expect(result.entries[0].fields).toHaveProperty("fits");
    expect(result.entries[0].truncatedFields).toEqual(["fields.huge"]);
    expect(result.entries[1].fields).toEqual({ small: 0 });
    expect(result.entries[1].truncatedFields).toEqual(["fields.tooLarge"]);
    expect(result.entries[2].fields).toEqual({});
    expect(result.entries[2].truncatedFields).toEqual(["metadata"]);
    expect(result).toMatchObject({ nextSkip: 3, total: 90, truncated: true });
  });

  it("retains all entry identities when the first entry exhausts the field budget", async () => {
    mockResponse({
      items: [
        entry("first", { exact: "x".repeat(19_890) }),
        ...Array.from({ length: 49 }, (_, index) =>
          entry(String(index), { value: true })
        ),
      ],
      total: 50,
    });
    const result = await runContentfulQuery({ ...queryInput, limit: 50 });
    expect(result.entries).toHaveLength(50);
    expect(
      result.entries.reduce(
        (total, item) => total + JSON.stringify(item.fields).length,
        0
      )
    ).toBeLessThanOrEqual(20_000);
    expect(result.entries[49].truncatedFields).toEqual(["fields.value"]);
    expect(result.nextSkip).toBeNull();
  });

  it.each([
    "limit",
    "skip",
    "cursor",
    "include",
    "locale",
    "access_token",
    "url",
    "method",
    "headers",
    "fields.title&limit",
    "fields./../",
  ])("rejects unsupported parameter %s before any request", async (name) => {
    const request = mockResponse({});
    await expect(
      runContentfulQuery({ ...queryInput, parameters: [{ name, value: "1" }] })
    ).rejects.toThrow("Unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects duplicate names and invalid selections", async () => {
    const request = mockResponse({});
    await expect(
      runContentfulQuery({
        ...queryInput,
        parameters: [
          { name: "query", value: "a" },
          { name: "query", value: "b" },
        ],
      })
    ).rejects.toThrow("Duplicate");
    await Promise.all(
      ["", "fields.title,", "fields/../sys", "https://example.com"].map(
        (value) =>
          expect(
            runContentfulQuery({
              ...queryInput,
              parameters: [{ name: "select", value }],
            })
          ).rejects.toThrow("select")
      )
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      case: "a value over 2,000 characters",
      message: "Too big: expected string to have <=2000 characters",
      parameters: [{ name: "query", value: "x".repeat(2001) }],
    },
    {
      case: "more than 30 parameters",
      message: "Too big: expected array to have <=30 items",
      parameters: Array.from({ length: 31 }, (_, index) => ({
        name: `fields.f${index}`,
        value: "x",
      })),
    },
    {
      case: "an encoded query over 16,000 characters",
      message:
        "Contentful query exceeds the 16,000-character encoded parameter limit.",
      parameters: Array.from({ length: 10 }, (_, index) => ({
        name: `fields.f${index}`,
        value: "x".repeat(2000),
      })),
    },
  ])("rejects $case before any request", async ({ message, parameters }) => {
    const request = mockResponse({});
    await expect(
      runContentfulQuery({ ...queryInput, parameters })
    ).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports empty results and missing totals without inventing counts", async () => {
    mockResponse({ items: [], total: 0 });
    expect(await runContentfulQuery(queryInput)).toMatchObject({
      entries: [],
      nextSkip: null,
      total: 0,
      truncated: false,
    });
    mockResponse({ items: [entry("one")] });
    expect(await runContentfulQuery({ ...queryInput, limit: 1 })).toMatchObject(
      { nextSkip: 1, total: null }
    );
  });
});

describe("Contentful read boundaries and errors", () => {
  it.each([
    [{ limit: 0 }, "Too small: expected number to be >=1"],
    [{ limit: 51 }, "Too big: expected number to be <=50"],
    [{ limit: 1.5 }, "Invalid input: expected int, received number"],
    [{ skip: -1 }, "Too small: expected number to be >=0"],
    [{ skip: Number.MAX_SAFE_INTEGER }, "Too big: expected number to be <="],
    [{ space: "https://example.com" }, "Space is not configured."],
    [{ url: "https://example.com" }, "Unrecognized key"],
    [{ method: "PUT" }, "Unrecognized key"],
  ] as const)(
    "rejects invalid input %j before any request",
    async (override, message) => {
      const request = mockResponse({});
      // Exercise runtime validation independently of TypeScript's input checks.
      await expect(
        // SAFETY: Intentionally malformed overrides verify runtime rejection before any network request.
        runContentfulQuery({ ...queryInput, ...override } as Parameters<
          typeof runContentfulQuery
        >[0])
      ).rejects.toThrow(message);
      expect(request).not.toHaveBeenCalled();
    }
  );

  it("surfaces API errors instead of returning partial results", async () => {
    mockResponse({ message: "API failure" }, 500);
    await expect(runContentfulQuery(queryInput)).rejects.toThrow(
      "Contentful API returned 500 (API failure)."
    );
  });

  it("forwards cancellation and rejects aborted requests without retrying", async () => {
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockImplementation((_url: URL, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort();
        return Promise.reject(new DOMException("Cancelled", "AbortError"));
      });
    vi.stubGlobal("fetch", request);
    await expect(
      runContentfulQuery(queryInput, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

const userLink = (id: string) => ({
  sys: { id, linkType: "User", type: "Link" as const },
});

describe("Contentful query actor attribution", () => {
  const actors = {
    createdBy: userLink("creator"),
    publishedBy: userLink("publisher"),
    updatedBy: userLink("editor"),
  };

  it.each([null, false])(
    "returns actor IDs without user requests when resolveUsers=%s",
    async (resolveUsers) => {
      const request = mockResponse({
        items: [entry("guide", {}, actors), entry("draft")],
        total: 63,
      });
      const result = await runContentfulQuery({ ...queryInput, resolveUsers });
      expect(result).toMatchObject({
        entries: [
          {
            createdByUserId: "creator",
            publishedByUserId: "publisher",
            updatedByUserId: "editor",
          },
          {
            createdByUserId: null,
            publishedByUserId: null,
            updatedByUserId: null,
          },
        ],
        total: 63,
        unresolvedUserIds: null,
        users: null,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(requestedUrl(request).searchParams.has("resolveUsers")).toBe(
        false
      );
    }
  );

  it.each([
    ["docs", "sample-docs", "fields"],
    ["site", "sample-site", "references"],
  ] as const)(
    "resolves names once per distinct actor in %s %s %s mode",
    async (space, spaceId, resultMode) => {
      const controller = new AbortController();
      const request = mockResponse({
        email: "private@example.com",
        firstName: "  Alex  ",
        lastName: " Smith ",
        sys: { id: "editor" },
      });
      request.mockResolvedValueOnce(
        Response.json({
          items: [
            entry(
              "one",
              { main: [link("component")] },
              {
                createdBy: userLink("editor"),
                publishedBy: userLink("editor"),
                updatedBy: userLink("editor"),
              }
            ),
            entry("two", {}, { updatedBy: userLink("editor") }),
          ],
          total: 63,
        })
      );
      const result = await runContentfulQuery(
        {
          ...queryInput,
          limit: 50,
          parameters: [{ name: "select", value: "sys,fields.main" }],
          resolveUsers: true,
          resultMode,
          space,
        },
        controller.signal
      );
      expect(result).toMatchObject({
        entries: [
          { createdByUserId: "editor", updatedByUserId: "editor" },
          { updatedByUserId: "editor" },
        ],
        nextSkip: 2,
        total: 63,
        unresolvedUserIds: [],
        users: [{ name: "Alex Smith", userId: "editor" }],
      });
      expect(JSON.stringify(result)).not.toContain("private@example.com");
      expect(request).toHaveBeenCalledTimes(2);
      const [, [url, init]] = request.mock.calls;
      expect(new URL(String(url)).pathname).toBe(
        `/spaces/${spaceId}/users/editor`
      );
      expect(init).toMatchObject({
        headers: {
          authorization: `Bearer ${process.env.CONTENTFUL_MANAGEMENT_TOKEN}`,
        },
        method: "GET",
        signal: controller.signal,
      });
    }
  );

  it("reports missing (404) and nameless users as unresolved without dropping their actor IDs", async () => {
    const request = mockResponse({ firstName: " ", sys: { id: "editor" } });
    request
      .mockResolvedValueOnce(
        Response.json({ items: [entry("guide", {}, actors)], total: 1 })
      )
      .mockResolvedValueOnce(
        Response.json({ message: "Missing" }, { status: 404 })
      )
      .mockResolvedValueOnce(
        Response.json({ lastName: "Publisher", sys: { id: "publisher" } })
      );
    expect(
      await runContentfulQuery({ ...queryInput, resolveUsers: true })
    ).toMatchObject({
      entries: [{ createdByUserId: "creator", updatedByUserId: "editor" }],
      unresolvedUserIds: ["creator", "editor"],
      users: [{ name: "Publisher", userId: "publisher" }],
    });
  });

  // Only 404 marks a user unresolved; any other failed lookup fails the tool.
  it.each([400, 403, 429, 500])(
    "surfaces user lookup %s failures as tool errors",
    async (status) => {
      const request = mockResponse({ message: "Lookup failed" }, status);
      request.mockResolvedValueOnce(
        Response.json({
          items: [entry("guide", {}, { updatedBy: userLink("editor") })],
          total: 1,
        })
      );
      await expect(
        runContentfulQuery({ ...queryInput, resolveUsers: true })
      ).rejects.toThrow(`Contentful API returned ${status}`);
      expect(request).toHaveBeenCalledTimes(2);
    }
  );

  it("bounds concurrency across all 150 possible page actors", async () => {
    let active = 0;
    let maximum = 0;
    const request = vi.fn().mockImplementation(async (url: URL) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return Response.json({
        firstName: "Name",
        sys: { id: url.pathname.split("/").at(-1) },
      });
    });
    request.mockResolvedValueOnce(
      Response.json({
        items: Array.from({ length: 50 }, (_, index) =>
          entry(
            `guide-${index}`,
            {},
            {
              createdBy: userLink(`creator-${index}`),
              publishedBy: userLink(`publisher-${index}`),
              updatedBy: userLink(`editor-${index}`),
            }
          )
        ),
        total: 50,
      })
    );
    vi.stubGlobal("fetch", request);
    const result = await runContentfulQuery({
      ...queryInput,
      limit: 50,
      resolveUsers: true,
    });
    expect(result.users).toHaveLength(150);
    expect(result.unresolvedUserIds).toEqual([]);
    expect(maximum).toBe(4);
    expect(request).toHaveBeenCalledTimes(151);
  });

  it("stops scheduling user lookups after cancellation", async () => {
    const controller = new AbortController();
    const request = vi
      .fn()
      .mockImplementation((url: URL, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        // Cancel while answering the last lookup of the first batch of four;
        // that batch still resolves, so only the next batch must be skipped.
        if (request.mock.calls.length === 5) {
          controller.abort();
        }
        return Promise.resolve(
          Response.json({
            firstName: "Name",
            sys: { id: new URL(String(url)).pathname.split("/").at(-1) },
          })
        );
      });
    request.mockResolvedValueOnce(
      Response.json({
        items: Array.from({ length: 10 }, (_, index) =>
          entry(
            `guide-${index}`,
            {},
            { updatedBy: userLink(`editor-${index}`) }
          )
        ),
        total: 10,
      })
    );
    vi.stubGlobal("fetch", request);
    await expect(
      runContentfulQuery(
        { ...queryInput, resolveUsers: true },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    // One entries query plus the four lookups of the first batch.
    expect(request).toHaveBeenCalledTimes(5);
  });

  it.each([
    "../escape",
    "a/b",
    "user?query=1",
    "https://example.com",
    "x".repeat(129),
  ])(
    "rejects unsafe returned actor IDs before user lookup: %s",
    async (userId) => {
      const request = mockResponse({
        items: [entry("guide", {}, { updatedBy: userLink(userId) })],
        total: 1,
      });
      await expect(
        runContentfulQuery({ ...queryInput, resolveUsers: true })
      ).rejects.toThrow("invalid actor user ID");
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it.each([{ items: [] }, { items: [entry("draft")] }])(
    "returns empty resolution without user requests when no actors are present: %j",
    async ({ items }) => {
      const request = mockResponse({ items, total: items.length });
      expect(
        await runContentfulQuery({ ...queryInput, resolveUsers: true })
      ).toMatchObject({ unresolvedUserIds: [], users: [] });
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects mismatched user identities", async () => {
    const request = mockResponse({
      firstName: "Wrong person",
      sys: { id: "someone-else" },
    });
    request.mockResolvedValueOnce(
      Response.json({
        items: [entry("guide", {}, { updatedBy: userLink("editor") })],
        total: 1,
      })
    );
    await expect(
      runContentfulQuery({ ...queryInput, resolveUsers: true })
    ).rejects.toThrow("mismatched user ID");
  });

  it("requires a nullable boolean resolveUsers input", () => {
    for (const resolveUsers of [undefined, "true", 1]) {
      expect(
        contentfulQueryInputSchema.safeParse({ ...queryInput, resolveUsers })
          .success
      ).toBe(false);
    }
  });
});

const document = (...content: JsonValue[]) => ({
  content,
  data: {},
  nodeType: "document",
});

const referenceNode = (nodeType: string, target: JsonValue) => ({
  content: [],
  data: { target },
  nodeType,
});

describe("Contentful reference projection", () => {
  const referenceInput = {
    ...queryInput,
    parameters: [
      { name: "content_type", value: "guide" },
      { name: "select", value: "sys,fields.title,fields.slug,fields.main" },
    ],
    resultMode: "references" as const,
    space: "docs" as const,
  };

  it("finds components across 33 oversized guide bodies, then resolves their types with one sys.id[in] request", async () => {
    const items = Array.from({ length: 33 }, (_, index) =>
      entry(
        `guide-${index}`,
        {
          main: document(
            {
              content: [
                {
                  data: {},
                  marks: [],
                  nodeType: "text",
                  value: "article prose ".repeat(4000),
                },
              ],
              data: {},
              nodeType: "paragraph",
            },
            referenceNode("embedded-entry-block", link("shared-code-block")),
            referenceNode("entry-hyperlink", link("linked-guide"))
          ),
          slug: `guide-${index}`,
          title: `Guide ${index}`,
        },
        {
          contentType: contentType("guide"),
          firstPublishedAt: "2026-09-09T10:00:00Z",
          publishedVersion: 1,
          version: 2,
        }
      )
    );
    const request = mockResponse({ items, total: 33 });
    const result = await runContentfulQuery({ ...referenceInput, limit: 50 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(requestedUrl(request).searchParams.get("limit")).toBe("50");
    expect(requestedUrl(request).searchParams.has("resultMode")).toBe(false);
    expect(result).toMatchObject({
      nextSkip: null,
      referencesComplete: true,
      resultMode: "references",
      total: 33,
      truncated: false,
    });
    expect(result.entries).toHaveLength(33);
    for (const [index, item] of result.entries.entries()) {
      expect(item).toMatchObject({
        entryId: `guide-${index}`,
        fields: { slug: `guide-${index}`, title: `Guide ${index}` },
        firstPublishedAt: "2026-09-09T10:00:00Z",
        referenceCoverage: {
          complete: true,
          found: 2,
          omitted: 0,
          returned: 2,
          unsupported: 0,
        },
        truncatedFields: [],
      });
      expect(item.fields).not.toHaveProperty("main");
      expect(item.references).toEqual([
        {
          field: "/main",
          id: "shared-code-block",
          linkType: "Entry",
          nodeType: "embedded-entry-block",
          path: "/main/content/1/data/target",
          relationship: "embed",
        },
        {
          field: "/main",
          id: "linked-guide",
          linkType: "Entry",
          nodeType: "entry-hyperlink",
          path: "/main/content/2/data/target",
          relationship: "hyperlink",
        },
      ]);
    }
    expect(JSON.stringify(result)).not.toContain("article prose");
    request.mockResolvedValueOnce(
      Response.json({
        items: [
          entry(
            "shared-code-block",
            {},
            { contentType: contentType("codeBlock") }
          ),
        ],
        total: 1,
      })
    );
    const types = await runContentfulQuery({
      ...queryInput,
      includeArchived: true,
      parameters: [
        { name: "sys.id[in]", value: "shared-code-block" },
        { name: "select", value: "sys" },
      ],
      space: "docs",
    });
    expect(request).toHaveBeenCalledTimes(2);
    const typeLookup = new URL(String(request.mock.calls[1][0]));
    expect(typeLookup.pathname).toBe(
      "/spaces/sample-docs/environments/master/entries"
    );
    expect(typeLookup.searchParams.get("sys.id[in]")).toBe("shared-code-block");
    expect(typeLookup.searchParams.get("select")).toBe("sys");
    expect(typeLookup.searchParams.has("sys.archivedAt[exists]")).toBe(false);
    expect(types.entries[0]).toMatchObject({
      contentTypeId: "codeBlock",
      entryId: "shared-code-block",
    });
  });

  it("preserves direct, nested, inline, asset and hyperlink locations without mistaking JSON for rich text", async () => {
    const raw = entry("guide", {
      json: {
        "a~/b": link("nested"),
        fakeNode: referenceNode(
          "embedded-entry-block",
          link("not-a-rich-embed")
        ),
      },
      list: [link("direct"), link("second")],
      main: document(
        referenceNode("embedded-entry-inline", link("inline")),
        referenceNode("embedded-asset-block", {
          sys: { id: "image", linkType: "Asset", type: "Link" },
        }),
        referenceNode("asset-hyperlink", {
          sys: { id: "image", linkType: "Asset", type: "Link" },
        }),
        referenceNode("embedded-resource-block", {
          sys: {
            linkType: "Contentful:Entry",
            type: "ResourceLink",
            urn: "crn:contentful:::content:spaces/other/environments/master/entries/remote",
          },
        })
      ),
      scalar: link("direct"),
    });
    Object.assign(raw.fields, { frenchOnly: { "fr-FR": link("french") } });
    mockResponse({ items: [raw], total: 1 });
    const result = await runContentfulQuery({
      ...referenceInput,
      parameters: [{ name: "select", value: "fields" }],
    });
    expect(result.entries[0].references).toEqual(
      expect.arrayContaining([
        {
          field: "/scalar",
          id: "direct",
          linkType: "Entry",
          nodeType: null,
          path: "/scalar",
          relationship: "reference",
        },
        {
          field: "/list",
          id: "direct",
          linkType: "Entry",
          nodeType: null,
          path: "/list/0",
          relationship: "reference",
        },
        {
          field: "/list",
          id: "second",
          linkType: "Entry",
          nodeType: null,
          path: "/list/1",
          relationship: "reference",
        },
        {
          field: "/json",
          id: "nested",
          linkType: "Entry",
          nodeType: null,
          path: "/json/a~0~1b",
          relationship: "reference",
        },
        {
          field: "/json",
          id: "not-a-rich-embed",
          linkType: "Entry",
          nodeType: null,
          path: "/json/fakeNode/data/target",
          relationship: "reference",
        },
        {
          field: "/main",
          id: "inline",
          linkType: "Entry",
          nodeType: "embedded-entry-inline",
          path: "/main/content/0/data/target",
          relationship: "embed",
        },
        {
          field: "/main",
          id: "image",
          linkType: "Asset",
          nodeType: "embedded-asset-block",
          path: "/main/content/1/data/target",
          relationship: "embed",
        },
        {
          field: "/main",
          id: "image",
          linkType: "Asset",
          nodeType: "asset-hyperlink",
          path: "/main/content/2/data/target",
          relationship: "hyperlink",
        },
      ])
    );
    expect(result).toMatchObject({
      entries: [
        {
          referenceCoverage: {
            complete: false,
            found: 8,
            omitted: 0,
            returned: 8,
            scannedFields: ["/json", "/list", "/main", "/scalar"],
            unsupported: 1,
          },
        },
      ],
      referencesComplete: false,
      truncated: false,
    });
  });

  it("reports a shared reference count cap without losing guide identities or API totals", async () => {
    mockResponse({
      items: [
        entry("first", {
          refs: Array.from({ length: 501 }, (_, index) => link(`id-${index}`)),
        }),
        entry("second", { refs: [link("last")] }),
      ],
      total: 9,
    });
    const result = await runContentfulQuery({
      ...referenceInput,
      parameters: [{ name: "select", value: "fields.refs" }],
    });
    expect(result).toMatchObject({
      entries: [
        {
          entryId: "first",
          referenceCoverage: {
            complete: false,
            found: 501,
            omitted: 1,
            returned: 500,
          },
        },
        {
          entryId: "second",
          referenceCoverage: {
            complete: false,
            found: 1,
            omitted: 1,
            returned: 0,
          },
          references: [],
        },
      ],
      nextSkip: 2,
      referencesComplete: false,
      total: 9,
      truncated: true,
    });
  });

  it("bounds serialized reference locations while retaining complete occurrence counts", async () => {
    mockResponse({
      items: [
        entry("guide", {
          main: {
            ["long-key".repeat(400)]: Array.from({ length: 40 }, (_, index) =>
              link(String(index))
            ),
          },
        }),
      ],
      total: 1,
    });
    const result = await runContentfulQuery(referenceInput);
    const [item] = result.entries;
    expect(JSON.stringify(item.references).length).toBeLessThanOrEqual(100_000);
    expect(item.referenceCoverage?.found).toBe(40);
    expect(item.referenceCoverage?.returned).toBeGreaterThan(0);
    expect(item.referenceCoverage?.omitted).toBeGreaterThan(0);
    expect(result).toMatchObject({
      nextSkip: null,
      referencesComplete: false,
      truncated: true,
    });
  });

  it("distinguishes a fully scanned field with no references from unselected fields", async () => {
    mockResponse({
      items: [
        entry("guide", {
          main: document({
            content: [{ nodeType: "text", value: "No links" }],
            nodeType: "paragraph",
          }),
        }),
      ],
      total: 1,
    });
    const result = await runContentfulQuery(referenceInput);
    expect(result).toMatchObject({
      entries: [
        {
          referenceCoverage: {
            complete: true,
            found: 0,
            omitted: 0,
            returned: 0,
            scannedFields: ["/main"],
            unsupported: 0,
          },
          references: [],
        },
      ],
      referencesComplete: true,
      truncated: false,
    });
  });

  it("reports malformed link targets as incomplete evidence", async () => {
    mockResponse({
      items: [
        entry("guide", {
          main: document(
            referenceNode("embedded-entry-block", {
              sys: { linkType: "Entry", type: "Link" },
            }),
            referenceNode("embedded-entry-inline", link(""))
          ),
        }),
      ],
      total: 1,
    });
    const result = await runContentfulQuery(referenceInput);
    expect(result).toMatchObject({
      entries: [
        {
          referenceCoverage: {
            complete: false,
            found: 0,
            returned: 0,
            unsupported: 2,
          },
          references: [],
        },
      ],
      referencesComplete: false,
      truncated: false,
    });
  });

  it("rejects reference projection without an explicit field selection", async () => {
    const request = mockResponse({});
    await Promise.all(
      [
        [],
        [{ name: "select", value: "sys" }],
        [{ name: "select", value: "sys,fields._displayField" }],
      ].map((parameters) =>
        expect(
          runContentfulQuery({ ...referenceInput, parameters })
        ).rejects.toThrow("explicit select")
      )
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("requires resultMode and treats null as fields mode", async () => {
    expect(
      contentfulQueryInputSchema.safeParse({
        ...queryInput,
        resultMode: undefined,
      }).success
    ).toBe(false);
    mockResponse({
      items: [entry("guide", { main: "body", title: "Title" })],
      total: 1,
    });
    const nullMode = await runContentfulQuery(queryInput);
    const explicit = await runContentfulQuery({
      ...queryInput,
      resultMode: "fields",
    });
    expect(explicit).toEqual(nullMode);
    expect(explicit).toMatchObject({
      entries: [
        {
          fields: { main: "body", title: "Title" },
          referenceCoverage: null,
          references: null,
        },
      ],
      referencesComplete: null,
      resultMode: "fields",
    });
  });
});
