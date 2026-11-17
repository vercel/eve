import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../json";
import type { ContentfulSchemaInput } from "./input-schemas";
import { getContentfulSchema } from "./schema";

const schemaInput: ContentfulSchemaInput = {
  contentTypeId: null,
  limit: null,
  skip: null,
  space: "docs",
};

const mockResponse = (body: JsonValue, status = 200) => {
  const request = vi.fn((_url: URL, _init: RequestInit): Promise<Response> =>
    Promise.resolve(Response.json(body, { status }))
  );
  vi.stubGlobal("fetch", request);
  return request;
};

const requestedUrl = (request: ReturnType<typeof mockResponse>) =>
  new URL(String(request.mock.calls[0][0]));

describe("Contentful schema discovery", () => {
  it.each([
    ["docs", "sample-docs"],
    ["site", "sample-site"],
  ] as const)(
    "lists the %s catalog with defaults and no schema cache",
    async (space, spaceId) => {
      const request = mockResponse({
        items: [
          { displayField: "label", name: "Custom", sys: { id: "custom" } },
        ],
        total: 30,
      });
      const result = await getContentfulSchema({ ...schemaInput, space });
      expect(requestedUrl(request).pathname).toBe(
        `/spaces/${spaceId}/environments/master/content_types`
      );
      expect(Object.fromEntries(requestedUrl(request).searchParams)).toEqual({
        limit: "25",
        order: "sys.id",
        skip: "0",
      });
      expect(result).toMatchObject({
        contentTypes: [{ displayField: "label", id: "custom", name: "Custom" }],
        nextSkip: 1,
        total: 30,
      });
      await getContentfulSchema({ ...schemaInput, space });
      expect(request).toHaveBeenCalledTimes(2);
    }
  );

  it("returns scalar, array, restricted and unrestricted reference schemas", async () => {
    const request = mockResponse({
      fields: [
        {
          id: "label",
          localized: true,
          name: "Label",
          required: true,
          type: "Symbol",
        },
        {
          id: "author",
          linkType: "Entry",
          name: "Author",
          type: "Link",
          validations: [{ linkContentType: ["person"] }],
        },
        {
          id: "related",
          items: {
            linkType: "Entry",
            type: "Link",
            validations: [{ linkContentType: ["blogPost", "guide"] }],
          },
          name: "Related",
          type: "Array",
        },
        { id: "image", linkType: "Asset", name: "Image", type: "Link" },
        { id: "anyEntry", linkType: "Entry", name: "Any entry", type: "Link" },
        {
          id: "labels",
          items: { type: "Symbol" },
          name: "Labels",
          type: "Array",
        },
      ],
      name: "Custom",
      sys: { id: "custom" },
    });
    const result = await getContentfulSchema({
      ...schemaInput,
      contentTypeId: "custom",
      limit: 1,
      skip: 10,
    });
    expect(requestedUrl(request).pathname).toBe(
      "/spaces/sample-docs/environments/master/content_types/custom"
    );
    expect(requestedUrl(request).search).toBe("");
    expect(result).toMatchObject({
      contentType: {
        displayField: null,
        fields: [
          {
            id: "label",
            items: null,
            localized: true,
            required: true,
            richTextReferences: null,
          },
          { allowedContentTypeIds: ["person"], id: "author" },
          {
            id: "related",
            items: {
              allowedContentTypeIds: ["blogPost", "guide"],
              linkType: "Entry",
              type: "Link",
            },
          },
          { allowedContentTypeIds: null, id: "image", linkType: "Asset" },
          { allowedContentTypeIds: null, id: "anyEntry", linkType: "Entry" },
          { id: "labels", items: { linkType: null, type: "Symbol" } },
        ],
      },
    });
  });

  it("describes enabled rich-text embeds separately from hyperlinks and assets", async () => {
    const request = mockResponse({
      fields: [
        {
          id: "body",
          name: "Body",
          type: "RichText",
          validations: [
            {
              enabledNodeTypes: [
                "paragraph",
                "embedded-entry-block",
                "embedded-entry-inline",
                "entry-hyperlink",
                "embedded-asset-block",
              ],
            },
            {
              nodes: {
                "asset-hyperlink": [{ size: { max: 1 } }],
                "embedded-asset-block": [{ size: { max: 2 } }],
                "embedded-entry-block": [
                  { size: { max: 10 } },
                  { linkContentType: ["codeBlock", "callout", "codeBlock"] },
                ],
                "embedded-entry-inline": [{ size: { max: 5 } }],
                "entry-hyperlink": [{ linkContentType: ["guide"] }],
              },
            },
          ],
        },
      ],
      name: "Guide",
      sys: { id: "guide" },
    });
    const result = await getContentfulSchema({
      ...schemaInput,
      contentTypeId: "guide",
    });
    expect(result).toMatchObject({
      contentType: {
        fields: [
          {
            richTextReferences: [
              {
                allowedContentTypeIds: ["codeBlock", "callout"],
                linkType: "Entry",
                nodeType: "embedded-entry-block",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Entry",
                nodeType: "embedded-entry-inline",
              },
              {
                allowedContentTypeIds: ["guide"],
                linkType: "Entry",
                nodeType: "entry-hyperlink",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Asset",
                nodeType: "embedded-asset-block",
              },
            ],
          },
        ],
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("distinguishes unrestricted rich text, disabled references, and empty target restrictions", async () => {
    mockResponse({
      fields: [
        { id: "unrestricted", name: "Unrestricted", type: "RichText" },
        {
          id: "disabled",
          name: "Disabled",
          type: "RichText",
          validations: [{ enabledNodeTypes: ["paragraph"] }],
        },
        {
          id: "emptyTargets",
          name: "Empty targets",
          type: "RichText",
          validations: [
            { enabledNodeTypes: ["embedded-entry-block"] },
            { nodes: { "embedded-entry-block": [{ linkContentType: [] }] } },
          ],
        },
      ],
      name: "Guide",
      sys: { id: "guide" },
    });
    const result = await getContentfulSchema({
      ...schemaInput,
      contentTypeId: "guide",
    });
    expect(result).toMatchObject({
      contentType: {
        fields: [
          {
            richTextReferences: [
              {
                allowedContentTypeIds: null,
                linkType: "Entry",
                nodeType: "embedded-entry-block",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Entry",
                nodeType: "embedded-entry-inline",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Entry",
                nodeType: "entry-hyperlink",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Asset",
                nodeType: "embedded-asset-block",
              },
              {
                allowedContentTypeIds: null,
                linkType: "Asset",
                nodeType: "asset-hyperlink",
              },
            ],
          },
          { richTextReferences: [] },
          {
            richTextReferences: [
              {
                allowedContentTypeIds: [],
                linkType: "Entry",
                nodeType: "embedded-entry-block",
              },
            ],
          },
        ],
      },
    });
  });

  it("honors all rich-text restrictions without treating cross-space resources as local links", async () => {
    mockResponse({
      fields: [
        {
          id: "body",
          name: "Body",
          type: "RichText",
          validations: [
            {
              enabledNodeTypes: [
                "embedded-entry-block",
                "embedded-entry-inline",
                "embedded-resource-block",
              ],
            },
            {
              enabledNodeTypes: [
                "embedded-entry-block",
                "embedded-resource-block",
              ],
            },
            {
              nodes: {
                "embedded-entry-block": [
                  { linkContentType: ["codeBlock", "callout"] },
                ],
              },
            },
            {
              nodes: {
                "embedded-entry-block": [
                  { linkContentType: ["codeBlock", "other"] },
                ],
                "embedded-resource-block": {
                  allowedResources: [
                    {
                      contentTypes: ["remoteComponent"],
                      source:
                        "crn:contentful:::content:spaces/other/environments/master",
                      type: "Contentful:Entry",
                    },
                  ],
                  validations: [{ size: { max: 5 } }],
                },
              },
            },
          ],
        },
      ],
      name: "Guide",
      sys: { id: "guide" },
    });
    const result = await getContentfulSchema({
      ...schemaInput,
      contentTypeId: "guide",
    });
    expect(result).toMatchObject({
      contentType: {
        fields: [
          {
            richTextReferences: [
              {
                allowedContentTypeIds: ["codeBlock"],
                linkType: "Entry",
                nodeType: "embedded-entry-block",
              },
            ],
          },
        ],
      },
    });
  });

  it("paginates the catalog and reports its final page", async () => {
    const request = mockResponse({
      items: [{ name: "Last", sys: { id: "last" } }],
      total: 26,
    });
    const result = await getContentfulSchema({
      ...schemaInput,
      limit: 1,
      skip: 25,
    });
    expect(requestedUrl(request).searchParams.get("skip")).toBe("25");
    expect(result).toMatchObject({ nextSkip: null, skip: 25, total: 26 });
  });

  it.each([
    "../entries",
    "%2e%2e",
    "custom?x=y",
    "https://example.com",
    "a/b",
    "",
  ])("rejects unsafe content type ID %s", async (contentTypeId) => {
    const request = mockResponse({});
    await expect(
      getContentfulSchema({ ...schemaInput, contentTypeId })
    ).rejects.toThrow('"contentTypeId"');
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Contentful schema read boundaries", () => {
  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { skip: -1 },
    { skip: Number.MAX_SAFE_INTEGER },
    { space: "https://example.com" },
    { url: "https://example.com" },
    { method: "PUT" },
  ])("rejects invalid input %j before any request", async (override) => {
    const request = mockResponse({});
    // Exercise runtime validation independently of TypeScript's input checks.
    await expect(
      // SAFETY: Intentionally malformed overrides verify runtime schema rejection before any network request.
      getContentfulSchema({
        ...schemaInput,
        ...override,
      } as ContentfulSchemaInput)
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces API errors for catalog and single-type reads", async () => {
    mockResponse({ message: "API failure" }, 500);
    await expect(getContentfulSchema(schemaInput)).rejects.toThrow(
      "Contentful API returned 500 (API failure)."
    );
    await expect(
      getContentfulSchema({ ...schemaInput, contentTypeId: "custom" })
    ).rejects.toThrow("Contentful API returned 500 (API failure).");
  });

  it("forwards cancellation and rejects aborted requests without retrying", async () => {
    const controller = new AbortController();
    const request = vi.fn((_url: URL, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    });
    vi.stubGlobal("fetch", request);
    await expect(
      getContentfulSchema(schemaInput, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
