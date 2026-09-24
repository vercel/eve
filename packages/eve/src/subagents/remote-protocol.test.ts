import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RemoteTaskProtocolError,
  requireRemoteTaskProtocol,
  resetRemoteTaskProtocolChecks,
} from "#subagents/remote-protocol.js";

const REMOTE = {
  headers: { authorization: "Bearer remote-token" },
  name: "billing",
  url: "https://billing.example/agents/",
};

function health(version: string | undefined): Response {
  return Response.json(
    { ok: true, status: "ready", workflowId: "workflow//agent" },
    { headers: version === undefined ? {} : { "x-eve-task-protocol": version } },
  );
}

beforeEach(() => {
  resetRemoteTaskProtocolChecks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireRemoteTaskProtocol", () => {
  it("reads the version from the remote's health route and remembers a match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(health("1"));
    vi.stubGlobal("fetch", fetchMock);

    await requireRemoteTaskProtocol(REMOTE);
    await requireRemoteTaskProtocol(REMOTE);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://billing.example/agents/eve/v1/health",
      expect.objectContaining({
        headers: REMOTE.headers,
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails for an older eve, whose health route reports no version, and checks again next time", async () => {
    const fetchMock = vi.fn().mockResolvedValue(health(undefined));
    vi.stubGlobal("fetch", fetchMock);

    const error = await requireRemoteTaskProtocol(REMOTE).catch((cause: unknown) => cause);
    await requireRemoteTaskProtocol(REMOTE).catch(() => {});

    expect(error).toBeInstanceOf(RemoteTaskProtocolError);
    expect(error).toMatchObject({
      message:
        'Remote agent "billing" cannot be called: its deployment reports no task protocol version (it runs an older eve), and this deployment uses version 1. Upgrade so both deployments use the same task protocol version.',
      remoteVersion: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails for a remote on another version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(health("2")));

    await expect(requireRemoteTaskProtocol(REMOTE)).rejects.toMatchObject({ remoteVersion: 2 });
  });

  it("fails with the status when the health route does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    await expect(requireRemoteTaskProtocol(REMOTE)).rejects.toThrow(
      'Remote agent "billing" health check failed with HTTP 502.',
    );
  });
});
