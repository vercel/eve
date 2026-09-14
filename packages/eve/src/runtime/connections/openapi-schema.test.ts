import { describe, expect, it } from "vitest";
import { derefSchema } from "./openapi-schema.js";

const richText = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["text"] },
        text: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      },
      required: ["text"],
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["mention"] },
        mention: {
          type: "object",
          properties: { page: { type: "object" } },
          required: ["page"],
        },
      },
      required: ["mention"],
    },
  ],
};

/** The shape of Notion's `createPage` request body, inlined as the API serves it. */
const createPageBody = {
  type: "object",
  properties: {
    properties: {
      type: "object",
      additionalProperties: {
        oneOf: [
          {
            type: "object",
            properties: { title: { type: "array", items: richText } },
            required: ["title"],
          },
          {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        ],
      },
    },
  },
};

function nest(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < levels; i += 1) {
    schema = { type: "object", properties: { child: schema } };
  }
  return schema;
}

describe("derefSchema", () => {
  it("keeps the constraints of alternatives nested deep inside a request body (#3267)", () => {
    const result = derefSchema({}, createPageBody) as Record<string, unknown>;
    const titleItems = (
      (
        (
          ((result.properties as Record<string, unknown>).properties as Record<string, unknown>)
            .additionalProperties as { oneOf: Record<string, unknown>[] }
        ).oneOf[0].properties as Record<string, unknown>
      ).title as { items: { oneOf: Record<string, unknown>[] } }
    ).items;
    // Both rich-text alternatives survive with their own `required` and nested
    // `text.content` / `mention.page` constraints, so a validator can still
    // tell them apart instead of matching every value against both.
    expect(titleItems.oneOf).toHaveLength(2);
    expect(titleItems.oneOf[0]).toMatchObject({
      required: ["text"],
      properties: { text: { properties: { content: { type: "string" } } } },
    });
    expect(titleItems.oneOf[1]).toMatchObject({
      required: ["mention"],
      properties: { mention: { properties: { page: { type: "object" } } } },
    });
  });

  it("still truncates inline nesting past the limit", () => {
    const result = derefSchema({}, nest(40));
    let node = result as Record<string, unknown>;
    let levels = 0;
    while (node.properties !== undefined) {
      node = (node.properties as Record<string, unknown>).child as Record<string, unknown>;
      levels += 1;
    }
    expect(levels).toBeGreaterThan(12);
    expect(levels).toBeLessThan(40);
    expect(node).toEqual({});
  });

  it("cuts reference cycles regardless of depth", () => {
    const document = {
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
    };
    const result = derefSchema(document, { $ref: "#/components/schemas/Node" }) as Record<
      string,
      unknown
    >;
    expect((result.properties as Record<string, unknown>).next).toEqual({});
  });
});
