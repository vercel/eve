import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContentfulApiError, callApi } from "./api";

const TOKEN_HINT =
  " Check that CONTENTFUL_MANAGEMENT_TOKEN is valid and has access to this space.";

const stubFetch = (response: () => Response) => {
  const request = vi.fn((_url: URL, _init: RequestInit): Promise<Response> =>
    Promise.resolve(response())
  );
  vi.stubGlobal("fetch", request);
  return request;
};

const failure = async (path = "/spaces/s/entries/e") => {
  try {
    await callApi(path, {});
  } catch (error) {
    return error;
  }
  throw new Error("Expected callApi to reject");
};

beforeEach(() => vi.stubEnv("CONTENTFUL_MANAGEMENT_TOKEN", "test-token"));

describe("Contentful API transport", () => {
  it("sends one authenticated GET with encoded query parameters and the caller's signal", async () => {
    const request = stubFetch(() => Response.json({ ok: true }));
    const { signal } = new AbortController();
    expect(
      await callApi("/spaces/s/entries", { query: "a&b=c é" }, signal)
    ).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [[url, init]] = request.mock.calls;
    expect(url.href).toBe(
      "https://api.contentful.com/spaces/s/entries?query=a%26b%3Dc+%C3%A9"
    );
    expect(init).toEqual({
      headers: {
        accept: "application/json",
        authorization: "Bearer test-token",
      },
      method: "GET",
      signal,
    });
  });

  it("sends the method, body, and extra headers for writes", async () => {
    const request = stubFetch(() => Response.json({ sys: { id: "e" } }));
    await callApi("/spaces/s/entries/e", {}, undefined, {
      body: '{"fields":{}}',
      headers: { "X-Contentful-Version": "3" },
      method: "PUT",
    });
    expect(request.mock.calls[0][1]).toMatchObject({
      body: '{"fields":{}}',
      headers: {
        "X-Contentful-Version": "3",
        authorization: "Bearer test-token",
      },
      method: "PUT",
    });
  });

  it("returns undefined for a 204 response", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await callApi<undefined>("/spaces/s/entries/e", {})).toBeUndefined();
  });

  it.each([
    [401, TOKEN_HINT],
    [403, TOKEN_HINT],
    [404, " The entry, environment, or space was not found."],
    [400, ""],
    [429, ""],
    [500, ""],
  ])("formats a %s failure with its status hint", async (status, hint) => {
    const request = stubFetch(() =>
      Response.json({ message: "API failure" }, { status })
    );
    const error = await failure();
    expect(error).toBeInstanceOf(ContentfulApiError);
    expect(error).toMatchObject({
      message: `Contentful API returned ${status} (API failure).${hint}`,
      status,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lists every validation failure with its field path instead of the top-level message", async () => {
    stubFetch(() =>
      Response.json(
        {
          details: {
            errors: [
              { details: "Size must be at most 10", path: ["fields", "title"] },
              { name: "required", path: ["fields", "slug", "en-US"] },
              {},
            ],
          },
          message: "Validation error",
        },
        { status: 422 }
      )
    );
    expect(await failure()).toMatchObject({
      message:
        "Contentful API returned 422 (fields.title: Size must be at most 10; fields.slug.en-US: required; entry: invalid).",
      status: 422,
    });
  });

  it.each([
    [
      "the error ID when there is no message",
      { sys: { id: "RateLimitExceeded" } },
      " (RateLimitExceeded)",
    ],
    ["no detail for an empty JSON body", {}, ""],
  ])("falls back to %s", async (_case, body, detail) => {
    stubFetch(() => Response.json(body, { status: 429 }));
    expect(await failure()).toMatchObject({
      message: `Contentful API returned 429${detail}.`,
    });
  });

  it("ignores a non-JSON error body", async () => {
    stubFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await failure()).toMatchObject({
      message: "Contentful API returned 502.",
      status: 502,
    });
  });

  it("propagates cancellation without retrying", async () => {
    const request = vi.fn((_url: URL, _init: RequestInit): Promise<Response> =>
      Promise.reject(new DOMException("Cancelled", "AbortError"))
    );
    vi.stubGlobal("fetch", request);
    await expect(callApi("/spaces/s/entries", {})).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
