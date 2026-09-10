import { describe, expect, it } from "vitest";

import { extractEveDevServerOrigin, normalizeDevServerRegistry } from "./dev-server.js";

describe("extractEveDevServerOrigin", () => {
  it("returns undefined when the chunk has no readiness line", () => {
    expect(
      extractEveDevServerOrigin("resolving rolldown... https://rolldown.rs/guide"),
    ).toBeUndefined();
  });

  it("returns the origin from the readiness line", () => {
    expect(extractEveDevServerOrigin("[DEV] server listening at http://127.0.0.1:50036/\n")).toBe(
      "http://127.0.0.1:50036",
    );
  });

  it("does not depend on the CLI tag", () => {
    expect(extractEveDevServerOrigin("server listening at http://127.0.0.1:50036/\n")).toBe(
      "http://127.0.0.1:50036",
    );
  });

  it("ignores unrelated URLs that appear before the readiness line", () => {
    expect(
      extractEveDevServerOrigin(
        "warn: https://rolldown.rs/guide\n[DEV] server listening at http://127.0.0.1:50036/\n",
      ),
    ).toBe("http://127.0.0.1:50036");
  });

  it("accepts a chunk that ends at the URL without a trailing newline", () => {
    expect(extractEveDevServerOrigin("[DEV] server listening at http://127.0.0.1:50036")).toBe(
      "http://127.0.0.1:50036",
    );
  });

  it("accepts an IPv6 loopback origin", () => {
    expect(extractEveDevServerOrigin("[DEV] server listening at http://[::1]:50036/")).toBe(
      "http://[::1]:50036",
    );
  });
});

describe("normalizeDevServerRegistry", () => {
  it("normalizes a well-formed record and canonicalizes the origin", () => {
    expect(
      normalizeDevServerRegistry({
        appRoot: "/app",
        origin: "http://127.0.0.1:49152/",
        pid: 1234,
        updatedAt: "2026-05-28T00:00:00.000Z",
      }),
    ).toEqual({
      appRoot: "/app",
      origin: "http://127.0.0.1:49152",
      pid: 1234,
      updatedAt: "2026-05-28T00:00:00.000Z",
    });
  });

  it("accepts a null pid", () => {
    expect(
      normalizeDevServerRegistry({
        appRoot: "/app",
        origin: "http://127.0.0.1:49152",
        pid: null,
        updatedAt: "2026-05-28T00:00:00.000Z",
      })?.pid,
    ).toBeNull();
  });

  const invalidCases: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "a scalar", value: "not a record" },
    { label: "null", value: null },
    { label: "an array", value: ["array"] },
    { label: "missing appRoot", value: { origin: "http://x", pid: null, updatedAt: "now" } },
    { label: "missing origin", value: { appRoot: "/app", pid: null, updatedAt: "now" } },
    { label: "missing updatedAt", value: { appRoot: "/app", origin: "http://x", pid: null } },
    {
      label: "a non-number pid",
      value: { appRoot: "/app", origin: "http://x", pid: "1", updatedAt: "now" },
    },
    {
      label: "an invalid origin",
      value: { appRoot: "/app", origin: "not a url", pid: null, updatedAt: "now" },
    },
  ];

  it.each(invalidCases)("returns undefined for $label", ({ value }) => {
    expect(normalizeDevServerRegistry(value)).toBeUndefined();
  });
});
