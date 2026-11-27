import { describe, expect, it, vi } from "vitest";

import { Sandbox } from "#compiled/@vercel/sandbox/index.js";

import { createVercelNetworkPolicySetter } from "#execution/sandbox/bindings/vercel-base-runtime.js";

function sandboxResponse(sessionId: string, policy: "allow-all" | "deny-all" = "allow-all") {
  const session = {
    id: sessionId,
    memory: 4096,
    vcpus: 2,
    region: "iad1",
    timeout: 1_800_000,
    status: "running",
    requestedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    cwd: "/workspace",
    networkPolicy: { mode: policy },
  };
  return Response.json({
    sandbox: {
      name: "policy-test",
      persistent: true,
      createdAt: 0,
      updatedAt: 0,
      currentSessionId: sessionId,
      status: "running",
    },
    session,
    routes: [],
  });
}

function stoppedResponse() {
  return Response.json(
    { error: { code: "sandbox_stopped", message: "Sandbox has stopped execution." } },
    { status: 410 },
  );
}

async function openSandbox(responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of [sandboxResponse("expired"), ...responses]) {
    fetch.mockResolvedValueOnce(response);
  }
  const sandbox = await Sandbox.get({
    name: "policy-test",
    projectId: "project",
    teamId: "team",
    token: "test-token",
    resume: false,
    fetch,
  });
  return { sandbox, fetch };
}

describe("Vercel live network policy", () => {
  it("resumes the same sandbox and applies the policy when its session expired", async () => {
    const { sandbox, fetch } = await openSandbox([
      stoppedResponse(),
      sandboxResponse("resumed"),
      sandboxResponse("resumed", "deny-all"),
    ]);

    await createVercelNetworkPolicySetter(sandbox)("deny-all");

    expect(sandbox.name).toBe("policy-test");
    expect(sandbox.currentSession().sessionId).toBe("resumed");
    expect(sandbox.currentSession().networkPolicy).toBe("deny-all");
    expect(
      fetch.mock.calls
        .slice(1)
        .map(([url, options]) => [
          new URL(String(url)).pathname,
          new URL(String(url)).searchParams.get("resume"),
          options?.body,
        ]),
    ).toEqual([
      [
        "/api/v2/sandboxes/sessions/expired/network-policy",
        null,
        JSON.stringify({ mode: "deny-all" }),
      ],
      ["/api/v2/sandboxes/policy-test", "true", undefined],
      [
        "/api/v2/sandboxes/sessions/resumed/network-policy",
        null,
        JSON.stringify({ mode: "deny-all" }),
      ],
    ]);
  });

  it("surfaces an authorization failure without resuming the sandbox", async () => {
    const { sandbox, fetch } = await openSandbox([
      Response.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 }),
    ]);

    await expect(createVercelNetworkPolicySetter(sandbox)("deny-all")).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after one resume when the policy update still fails", async () => {
    const { sandbox, fetch } = await openSandbox([
      stoppedResponse(),
      sandboxResponse("resumed"),
      stoppedResponse(),
    ]);

    await expect(createVercelNetworkPolicySetter(sandbox)("deny-all")).rejects.toMatchObject({
      response: { status: 410 },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
