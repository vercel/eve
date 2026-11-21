import { describe, expect, it, vi } from "vitest";

import { Sandbox } from "#compiled/@vercel/sandbox/index.js";

import { createVercelNetworkPolicySetter } from "#execution/sandbox/bindings/vercel-base-runtime.js";

const sandboxMetadata = {
  name: "policy-test",
  persistent: true,
  createdAt: 0,
  updatedAt: 0,
  status: "running",
};

function sessionMetadata(sessionId: string) {
  return {
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
  };
}

function sandboxResponse(sessionId: string) {
  return Response.json({
    sandbox: { ...sandboxMetadata, currentSessionId: sessionId },
    session: sessionMetadata(sessionId),
    routes: [],
  });
}

function sessionResponse(sessionId: string) {
  return Response.json({ session: sessionMetadata(sessionId) });
}

function savedResponse(sessionId: string) {
  return Response.json({ sandbox: { ...sandboxMetadata, currentSessionId: sessionId } });
}

function commandResponse(sessionId: string) {
  return Response.json({
    command: {
      id: "cmd",
      name: "true",
      args: [],
      cwd: "/workspace",
      sessionId,
      exitCode: null,
      startedAt: 0,
    },
  });
}

function stoppedResponse() {
  return Response.json(
    { error: { code: "sandbox_stopped", message: "Sandbox has stopped execution." } },
    { status: 410 },
  );
}

/** A handle whose cached session ("expired") is still running, as after a timeout. */
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
  const requests = () =>
    fetch.mock.calls.slice(1).map(([url, init]) => {
      const { pathname, searchParams } = new URL(String(url));
      return `${init?.method ?? "GET"} ${pathname}${searchParams.get("resume") ? "?resume=true" : ""}`;
    });
  return { requests, sandbox };
}

describe("Vercel live network policy", () => {
  it("resumes the same handle and reapplies the policy when its session stopped", async () => {
    const { requests, sandbox } = await openSandbox([
      stoppedResponse(),
      stoppedResponse(),
      sandboxResponse("resumed"),
      commandResponse("resumed"),
      sessionResponse("resumed"),
      savedResponse("resumed"),
    ]);

    await createVercelNetworkPolicySetter(sandbox)("deny-all");

    expect(sandbox.currentSession().sessionId).toBe("resumed");
    expect(requests()).toEqual([
      "POST /api/v2/sandboxes/sessions/expired/network-policy",
      "POST /api/v2/sandboxes/sessions/expired/cmd",
      "GET /api/v2/sandboxes/policy-test?resume=true",
      "POST /api/v2/sandboxes/sessions/resumed/cmd",
      "POST /api/v2/sandboxes/sessions/resumed/network-policy",
      "PATCH /api/v2/sandboxes/policy-test",
    ]);
  });

  it("surfaces other failures without resuming", async () => {
    const { requests, sandbox } = await openSandbox([
      Response.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 }),
    ]);

    await expect(createVercelNetworkPolicySetter(sandbox)("deny-all")).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(requests()).toEqual(["POST /api/v2/sandboxes/sessions/expired/network-policy"]);
  });

  it("retries only once", async () => {
    const { requests, sandbox } = await openSandbox([
      stoppedResponse(),
      commandResponse("expired"),
      stoppedResponse(),
    ]);

    await expect(createVercelNetworkPolicySetter(sandbox)("deny-all")).rejects.toMatchObject({
      response: { status: 410 },
    });
    expect(requests()).toHaveLength(3);
  });
});
