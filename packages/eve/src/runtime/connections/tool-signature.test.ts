import { describe, expect, it } from "vitest";

import { renderToolSignature } from "./tool-signature.js";

describe("renderToolSignature", () => {
  it.each([
    {
      name: "renders required and optional fields, literals, unions, and arrays",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer" },
          kind: { type: "string", enum: ["a", "b"] },
          version: { const: 2 },
          note: { type: ["string", "null"] },
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
          tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        },
        required: ["id", "kind"],
      },
      expected:
        'f(input: { id: number; kind: "a" | "b"; version?: 2; note?: string | null; value?: string | number; tags?: (string | number)[] }): Promise<unknown>',
    },
    {
      name: "quotes keys that are not identifiers and renders open objects as records",
      inputSchema: {
        type: "object",
        properties: { "x-trace-id": { type: "string" }, meta: { type: "object" } },
        additionalProperties: { type: "boolean" },
      },
      expected:
        'f(input: { "x-trace-id"?: string; meta?: Record<string, unknown>; [key: string]: boolean }): Promise<unknown>',
    },
    {
      name: "keeps descriptions and constraints as comments without breaking out of them",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", pattern: "^\\d{4}$", description: "Year as YYYY." },
          limit: { type: "integer", maximum: 50, description: "Stops at */ here" },
        },
      },
      expected:
        'f(input: { date?: string /* Year as YYYY; pattern: "^\\\\d{4}$" */; limit?: number /* Stops at * / here; maximum: 50 */ }): Promise<unknown>',
    },
    {
      name: "resolves local refs and stops at cycles",
      inputSchema: {
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        required: ["node"],
        $defs: {
          Node: {
            type: "object",
            properties: { name: { type: "string" }, next: { $ref: "#/$defs/Node" } },
            required: ["name"],
          },
        },
      },
      expected: "f(input: { node: { name: string; next?: unknown } }): Promise<unknown>",
    },
    {
      name: "renders the output type",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      expected: "f(input: Record<string, unknown>): Promise<{ ok: boolean }>",
    },
  ])("$name", ({ inputSchema, outputSchema, expected }) => {
    expect(renderToolSignature({ name: "f", inputSchema, outputSchema })).toBe(expected);
  });

  it("caps the signature length", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`field${index}`, { type: "string" }]),
    );
    const signature = renderToolSignature({
      name: "f",
      inputSchema: { type: "object", properties },
    });
    expect(signature).toHaveLength(4_000);
    expect(signature.endsWith("...")).toBe(true);
  });

  it("bounds the work for schemas whose shared refs expand exponentially", () => {
    // Each definition has ten properties pointing at the next: about 10^6 nodes
    // within the depth limit if every reference were expanded.
    const $defs = Object.fromEntries(
      Array.from({ length: 8 }, (_, level) => [
        `L${level}`,
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `p${index}`,
              { $ref: `#/$defs/L${level + 1}` },
            ]),
          ),
        },
      ]),
    );
    const started = performance.now();
    const signature = renderToolSignature({
      name: "f",
      inputSchema: { $ref: "#/$defs/L0", $defs },
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(signature.length).toBeLessThanOrEqual(4_000);
  });
});
