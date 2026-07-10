import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { defineExtension } from "#public/definitions/extension.js";

// Each test uses a distinct namespace because the config registry is process-global.

describe("defineExtension", () => {
  it("exposes the declared schema", () => {
    const schema = z.object({ apiKey: z.string() });
    const ext = defineExtension({ config: schema }, "schema-test");
    expect(ext.schema).toBe(schema);
  });

  it("binds values from the mount factory call and reads them with defaults applied", () => {
    const ext = defineExtension(
      {
        config: z.object({
          apiKey: z.string(),
          baseUrl: z.string().default("https://api.acme.example"),
        }),
      },
      "read-factory",
    );

    const mounted = ext({ apiKey: "sk-456" });

    expect(mounted).toBeDefined();
    expect(ext.config).toEqual({ apiKey: "sk-456", baseUrl: "https://api.acme.example" });
  });

  it("lets a bound value override a default", () => {
    const ext = defineExtension(
      { config: z.object({ baseUrl: z.string().default("https://default") }) },
      "read-override",
    );
    ext({ baseUrl: "https://override" });
    expect(ext.config).toEqual({ baseUrl: "https://override" });
  });

  it("applies schema defaults when read before an all-optional mount binds", () => {
    const ext = defineExtension(
      { config: z.object({ verbose: z.boolean().default(false) }) },
      "read-zero",
    );
    expect(ext.config).toEqual({ verbose: false });
  });

  it("rejects a missing required field at bind", () => {
    const ext = defineExtension({ config: z.object({ apiKey: z.string() }) }, "bind-required");
    // @ts-expect-error apiKey is required by the schema
    expect(() => ext({})).toThrow(/Invalid extension config/);
  });

  it("rejects a wrong-typed value at bind", () => {
    const ext = defineExtension({ config: z.object({ pageSize: z.number() }) }, "bind-type");
    // @ts-expect-error pageSize must be a number
    expect(() => ext({ pageSize: "nope" })).toThrow(/Invalid extension config/);
  });

  it("rejects a config schema that validates asynchronously", () => {
    const asyncSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => ({ value }),
      },
    };
    const ext = defineExtension({ config: asyncSchema }, "bind-async");
    expect(() => ext({})).toThrow(/validate synchronously/);
  });

  it("has an empty config and undefined schema with no config declared", () => {
    const ext = defineExtension(undefined, "noconfig-test");
    expect(ext.schema).toBeUndefined();
    expect(ext()).toBeDefined();
    expect(ext.config).toEqual({});
  });

  it("types the config reader from the schema", () => {
    const ext = defineExtension(
      { config: z.object({ apiKey: z.string(), tier: z.string().default("free") }) },
      "types-test",
    );
    ext({ apiKey: "k" });

    // Compile-time assertions (checked by `tsc`).
    const apiKey: string = ext.config.apiKey;
    const tier: string = ext.config.tier;
    // @ts-expect-error apiKey is a string, not a number
    const wrong: number = ext.config.apiKey;
    void wrong;

    expect(apiKey).toBe("k");
    expect(tier).toBe("free");
  });
});
