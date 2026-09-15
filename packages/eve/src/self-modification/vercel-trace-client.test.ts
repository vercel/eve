import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVercelAgentRunsClient } from "./vercel-trace-client.js";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(),
}));

afterEach(() => {
  vi.mocked(getVercelOidcToken).mockReset();
  vi.unstubAllGlobals();
});

describe("Vercel Agent Runs client", () => {
  it("derives its fixed scope from the runtime OIDC credential", async () => {
    const token = createFakeVercelOidcToken({
      owner_id: "team_runtime",
      project_id: "prj_runtime",
      sub: "owner:acme:project:weather-agent:environment:preview",
    });
    vi.mocked(getVercelOidcToken).mockResolvedValue(token);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ run: { id: "conversation-a" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVercelAgentRunsClient().getRun({ runId: "conversation-a", trace: true }),
    ).resolves.toEqual({ run: { id: "conversation-a" } });

    expect(getVercelOidcToken).toHaveBeenCalledWith();
    const [request, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(request));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      teamSlug: "acme",
      project: "weather-agent",
      environment: "preview",
      runId: "conversation-a",
      trace: "1",
    });
    expect(init?.headers).toEqual({ authorization: `Bearer ${token}` });
  });

  it("fails closed when the runtime credential lacks a deployed scope", async () => {
    vi.mocked(getVercelOidcToken).mockResolvedValue(
      createFakeVercelOidcToken({
        owner_id: "team_runtime",
        project_id: "prj_runtime",
        sub: "owner:acme:project:weather-agent:environment:development",
      }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVercelAgentRunsClient().getRun({ runId: "conversation-a", trace: false }),
    ).rejects.toThrow("Conversation traces are unavailable.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
