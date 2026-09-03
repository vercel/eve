import { describe, expect, it } from "vitest";

import {
  createServiceConfigRecord,
  parseVercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";

describe("parseVercelServicesConfig", () => {
  it("normalizes named service arrays", () => {
    const config = parseVercelServicesConfig(
      { services: [{ name: "eve", framework: "eve", root: "agent" }] },
      "vercel.json",
    );
    expect(createServiceConfigRecord(config.services)).toEqual({
      eve: { framework: "eve", root: "agent" },
    });
  });

  it.each([
    [null, /must contain a JSON object/],
    [{ services: null }, /services must be a JSON object or named service array/],
    [{ services: { eve: null } }, /service "eve" must contain a JSON object/],
    [{ services: [{}] }, /must have a non-empty name/],
    [{ services: { eve: { framework: 42 } } }, /framework must be a string/],
    [{ services: { eve: { mount: false } } }, /mount must be a string or JSON object/],
    [{ services: { eve: { routes: {} } } }, /routes must be an array/],
    [{ routes: {} }, /routes must be an array/],
    [{ routes: [{ destination: 42 }] }, /destination must be a string or JSON object/],
  ])("rejects malformed configuration %#", (value, expected) => {
    expect(() => parseVercelServicesConfig(value, "vercel.json")).toThrow(expected);
  });
});
