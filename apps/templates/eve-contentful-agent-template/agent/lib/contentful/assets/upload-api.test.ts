import { beforeEach, describe, expect, it, vi } from "vitest";

import { createContentfulUpload, readContentfulUpload } from "./upload-api";

const bytes = Buffer.from("89504e470d0a1a0a", "hex");
const resource = {
  sys: {
    expiresAt: "2099-01-01T00:00:00Z",
    id: "upload-1",
    space: { sys: { id: "space-1" } },
    type: "Upload",
  },
};

beforeEach(() => vi.stubEnv("CONTENTFUL_MANAGEMENT_TOKEN", "test-token"));

describe("Contentful binary Upload API", () => {
  it("sends bytes and cancellation to the fixed upload host", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(resource));
    vi.stubGlobal("fetch", request);
    const { signal } = new AbortController();
    expect(await createContentfulUpload("space-1", bytes, signal)).toEqual({
      expiresAt: resource.sys.expiresAt,
      id: "upload-1",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      new URL("https://upload.contentful.com/spaces/space-1/uploads"),
      expect.objectContaining({
        body: bytes,
        headers: expect.objectContaining({
          "Content-Type": "application/octet-stream",
          authorization: "Bearer test-token",
        }),
        method: "POST",
        redirect: "error",
        signal,
      })
    );
  });

  it.each([
    { ...resource.sys, id: "" },
    { ...resource.sys, expiresAt: "invalid" },
    { ...resource.sys, type: "Asset" },
    { ...resource.sys, space: { sys: { id: "different" } } },
  ])("rejects an invalid upload response: %j", async (sys) => {
    const request = vi.fn().mockResolvedValue(Response.json({ sys }));
    vi.stubGlobal("fetch", request);
    await expect(createContentfulUpload("space-1", bytes)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("requires the same upload ID when reconciling a saved upload", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(resource));
    vi.stubGlobal("fetch", request);
    await expect(
      readContentfulUpload("space-1", "different-id")
    ).rejects.toThrow("unexpected");
    expect(request.mock.calls[0][1].method).toBe("GET");
    expect(request.mock.calls[0][1].body).toBeUndefined();
  });

  it("does not retry an HTTP error", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({}, { status: 503 }));
    vi.stubGlobal("fetch", request);
    await expect(
      createContentfulUpload("space-1", bytes)
    ).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("refuses to send an upload without credentials", async () => {
    vi.stubEnv("CONTENTFUL_MANAGEMENT_TOKEN", "");
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(createContentfulUpload("space-1", bytes)).rejects.toThrow(
      "not set"
    );
    expect(request).not.toHaveBeenCalled();
  });
});
