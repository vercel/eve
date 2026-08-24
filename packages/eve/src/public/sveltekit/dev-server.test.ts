import { describe, expect, it } from "vitest";

import { normalizeDevServerRegistry } from "./dev-server.js";

describe("normalizeDevServerRegistry", () => {
  it("normalizes a well-formed record and canonicalizes the origin", () => {
    expect(
      normalizeDevServerRegistry({
        appRoot: "/app",
        origin: "http://127.0.0.1:49152/",
        pid: 1234,
        serverId: "server-1",
        updatedAt: "2026-05-28T00:00:00.000Z",
      }),
    ).toEqual({
      appRoot: "/app",
      origin: "http://127.0.0.1:49152",
      pid: 1234,
      serverId: "server-1",
      updatedAt: "2026-05-28T00:00:00.000Z",
    });
  });

  it("accepts a null pid", () => {
    expect(
      normalizeDevServerRegistry({
        appRoot: "/app",
        origin: "http://127.0.0.1:49152",
        pid: null,
        serverId: "server-1",
        updatedAt: "2026-05-28T00:00:00.000Z",
      })?.pid,
    ).toBeNull();
  });

  const invalidCases: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "a scalar", value: "not a record" },
    { label: "null", value: null },
    { label: "an array", value: ["array"] },
    {
      label: "missing appRoot",
      value: { origin: "http://x", pid: null, serverId: "server-1", updatedAt: "now" },
    },
    {
      label: "missing origin",
      value: { appRoot: "/app", pid: null, serverId: "server-1", updatedAt: "now" },
    },
    {
      label: "missing serverId",
      value: { appRoot: "/app", origin: "http://x", pid: null, updatedAt: "now" },
    },
    {
      label: "an empty serverId",
      value: {
        appRoot: "/app",
        origin: "http://x",
        pid: null,
        serverId: "",
        updatedAt: "now",
      },
    },
    {
      label: "missing updatedAt",
      value: { appRoot: "/app", origin: "http://x", pid: null, serverId: "server-1" },
    },
    {
      label: "a non-number pid",
      value: {
        appRoot: "/app",
        origin: "http://x",
        pid: "1",
        serverId: "server-1",
        updatedAt: "now",
      },
    },
    {
      label: "an invalid origin",
      value: {
        appRoot: "/app",
        origin: "not a url",
        pid: null,
        serverId: "server-1",
        updatedAt: "now",
      },
    },
  ];

  it.each(invalidCases)("returns undefined for $label", ({ value }) => {
    expect(normalizeDevServerRegistry(value)).toBeUndefined();
  });
});
