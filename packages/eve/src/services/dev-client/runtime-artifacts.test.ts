import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readDevelopmentRuntimeArtifactsRevision,
  rebuildDevelopmentRuntimeArtifacts,
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "./runtime-artifacts.js";

const SERVER_URL = "http://127.0.0.1:3000";

function stubFetch(implementation: () => Promise<unknown>): void {
  vi.stubGlobal("fetch", vi.fn(implementation));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDevelopmentRuntimeArtifactsRevision", () => {
  it("returns the revision from a successful response", async () => {
    stubFetch(async () => new Response(JSON.stringify({ revision: "rev-1" })));
    await expect(readDevelopmentRuntimeArtifactsRevision({ serverUrl: SERVER_URL })).resolves.toBe(
      "rev-1",
    );
  });

  it("returns undefined on a non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    await expect(
      readDevelopmentRuntimeArtifactsRevision({ serverUrl: SERVER_URL }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch rejects", async () => {
    stubFetch(async () => {
      throw new Error("connection refused");
    });
    await expect(
      readDevelopmentRuntimeArtifactsRevision({ serverUrl: SERVER_URL }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on a malformed or empty body", async () => {
    stubFetch(async () => new Response(JSON.stringify({ revision: "" })));
    await expect(
      readDevelopmentRuntimeArtifactsRevision({ serverUrl: SERVER_URL }),
    ).resolves.toBeUndefined();
  });
});

describe("development runtime artifact suspension", () => {
  it("posts to suspend and resume routes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ revision: "rev-3" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(suspendDevelopmentRuntimeArtifacts({ serverUrl: SERVER_URL })).resolves.toBe(true);
    await expect(resumeDevelopmentRuntimeArtifacts({ serverUrl: SERVER_URL })).resolves.toBe(
      "rev-3",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL("/eve/v1/dev/runtime-artifacts/suspend", SERVER_URL),
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("/eve/v1/dev/runtime-artifacts/resume", SERVER_URL),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("rebuildDevelopmentRuntimeArtifacts", () => {
  it("posts to the rebuild route and returns the revision", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ revision: "rev-2" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rebuildDevelopmentRuntimeArtifacts({ serverUrl: SERVER_URL })).resolves.toBe(
      "rev-2",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/eve/v1/dev/runtime-artifacts/rebuild", SERVER_URL),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
