import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { configureTraceSampling } from "./vercel-trace-sampling.js";

vi.mock("#internal/model-auth/vercel-cli.js", () => ({
  readVercelCliToken: vi.fn(),
}));

const token = vi.mocked(readVercelCliToken);
const link = { orgId: "team_123", projectId: "prj_new" };

beforeEach(() => {
  token.mockReset();
  token.mockResolvedValue("vercel-token");
});

afterEach(() => vi.unstubAllGlobals());

it.each([200, 204])("accepts a successful PUT with status %i", async (status) => {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : "{}", { status }));
  vi.stubGlobal("fetch", fetchMock);
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, prompter);

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.vercel.com/v1/drains/tracing/config?projectId=prj_new&teamId=team_123",
    expect.objectContaining({
      body: JSON.stringify({
        enabled: true,
        sampling: [{ type: "head_sampling", rate: 1 }],
      }),
      headers: {
        authorization: "Bearer vercel-token",
        "content-type": "application/json",
      },
      method: "PUT",
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
  expect(prompter.log.warning).not.toHaveBeenCalled();
});

it("warns but does not fail when Vercel rejects the PUT", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, prompter);

  expect(prompter.log.warning).toHaveBeenCalledWith(
    expect.stringContaining("100% for all environments"),
  );
});

it("warns if no token is available without attempting a PUT", async () => {
  token.mockResolvedValue(undefined);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, prompter);

  expect(fetchMock).not.toHaveBeenCalled();
  expect(prompter.log.warning).toHaveBeenCalledOnce();
});

it("uses a deployment warning when an existing project's API write fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  const { prompter } = createFakePrompter();

  await configureTraceSampling(link, prompter, undefined, "deployed");

  expect(prompter.log.warning).toHaveBeenCalledWith(
    expect.stringContaining("Deployment succeeded"),
  );
});
