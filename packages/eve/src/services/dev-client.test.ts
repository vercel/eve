import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/index.js";
import { createDevelopmentRuntimeArtifactSessionRefresher } from "#services/dev-client.js";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime-artifact refresher session rotation", () => {
  it("starts a fresh local session for normal prompts after the dev artifact revision changes", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://127.0.0.1:3000" });
    const refresher = createDevelopmentRuntimeArtifactSessionRefresher({
      serverUrl: "http://127.0.0.1:3000",
    });
    let session = client.session();

    session = await refresher.refresh({
      createSession: () => client.session(),
      message: "first",
      session,
    });
    await (await session.send({ message: "first" })).result();
    const before = session;
    session = await refresher.refresh({
      createSession: () => client.session(),
      message: "second",
      session,
    });
    await (await session.send({ message: "second" })).result();

    // The revision changed between turns, so the second prompt rotates onto a
    // fresh session and POSTs /session instead of continuing the first.
    expect(session).not.toBe(before);
    const postUrls = requests
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return request.method === "POST" && !pathname.startsWith("/eve/v1/dev/runtime-artifacts");
      })
      .map((request) => new URL(request.url).pathname);
    expect(postUrls).toEqual(["/eve/v1/session", "/eve/v1/session"]);
  });

  it("keeps the active local session for input-response resumes after the dev artifact revision changes", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://localhost:3000" });
    const refresher = createDevelopmentRuntimeArtifactSessionRefresher({
      serverUrl: "http://localhost:3000",
    });
    const inputResponses = [{ optionId: "approve", requestId: "request-1" }];
    let session = client.session();

    session = await refresher.refresh({
      createSession: () => client.session(),
      message: "approve a tool",
      session,
    });
    await (await session.send({ message: "approve a tool" })).result();
    const before = session;
    session = await refresher.refresh({
      createSession: () => client.session(),
      inputResponses,
      session,
    });
    expect(session).toBe(before);
    await (await session.send({ inputResponses })).result();

    const rebuilds = requests.filter(
      (request) => new URL(request.url).pathname === "/eve/v1/dev/runtime-artifacts/rebuild",
    );
    const postUrls = requests
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return request.method === "POST" && !pathname.startsWith("/eve/v1/dev/runtime-artifacts");
      })
      .map((request) => new URL(request.url).pathname);
    expect(rebuilds).toHaveLength(1);
    expect(postUrls).toEqual(["/eve/v1/session", "/eve/v1/session/session-1"]);
  });
});

describe("createDevelopmentRuntimeArtifactSessionRefresher", () => {
  it("reports local dev artifact revision changes for normal prompts", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresher = createDevelopmentRuntimeArtifactSessionRefresher({
      serverUrl: "http://localhost:3000",
    });
    const changes: Array<{ previousRevision: string; revision: string }> = [];
    const session = new Client({ host: "http://localhost:3000" }).session();

    await refresher.refresh({
      createSession: () => session,
      message: "first",
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
      session,
    });
    await refresher.refresh({
      createSession: () => session,
      message: "second",
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
      session,
    });

    expect(changes).toEqual([
      {
        previousRevision: "snapshot-a",
        revision: "snapshot-b",
      },
    ]);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === "/eve/v1/dev/runtime-artifacts/rebuild",
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === "/eve/v1/dev/runtime-artifacts",
      ),
    ).toHaveLength(0);
  });

  it("reports local dev artifact revision changes while idle", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresher = createDevelopmentRuntimeArtifactSessionRefresher({
      serverUrl: "http://localhost:3000",
    });
    const changes: Array<{ previousRevision: string; revision: string }> = [];
    const session = new Client({ host: "http://localhost:3000" }).session();

    await refresher.refreshIdle({
      createSession: () => session,
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
      session,
    });
    await refresher.refreshIdle({
      createSession: () => session,
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
      session,
    });

    expect(changes).toEqual([
      {
        previousRevision: "snapshot-a",
        revision: "snapshot-b",
      },
    ]);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === "/eve/v1/dev/runtime-artifacts",
      ),
    ).toHaveLength(2);
    expect(
      requests.filter(
        (request) => new URL(request.url).pathname === "/eve/v1/dev/runtime-artifacts/rebuild",
      ),
    ).toHaveLength(0);
  });
});

function createDevFetchMock(input: {
  readonly requests: Array<{ method: string; url: string }>;
  readonly revisions: readonly string[];
}) {
  let nextRevisionIndex = 0;
  let nextSessionIndex = 0;

  return vi.fn(async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = resolveRequestUrl(request);
    const method = init?.method ?? "GET";
    input.requests.push({ method, url });

    const pathname = new URL(url).pathname;
    if (
      pathname === "/eve/v1/dev/runtime-artifacts" ||
      pathname === "/eve/v1/dev/runtime-artifacts/rebuild"
    ) {
      const revision =
        input.revisions[Math.min(nextRevisionIndex, input.revisions.length - 1)] ?? "snapshot";
      nextRevisionIndex += 1;
      return Response.json({ revision });
    }

    if (method === "POST") {
      nextSessionIndex += 1;
      return Response.json({
        continuationToken: `token-${nextSessionIndex}`,
        sessionId: `session-${nextSessionIndex}`,
      });
    }

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"session.waiting"}\n'));
          controller.close();
        },
      }),
    );
  });
}

function resolveRequestUrl(request: Parameters<typeof fetch>[0]): string {
  if (typeof request === "string") {
    return request;
  }
  if (request instanceof URL) {
    return request.toString();
  }
  return request.url;
}
