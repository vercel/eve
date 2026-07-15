import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/index.js";
import { createDevelopmentRuntimeArtifactRefresher } from "#services/dev-client.js";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime-artifact refresher session continuity", () => {
  it("keeps the active local session for normal prompts after the dev artifact revision changes", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://127.0.0.1:3000" });
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://127.0.0.1:3000",
    });
    const session = client.session();

    await refresher.refresh({
      message: "first",
    });
    await (await session.send({ message: "first" })).result();
    const sessionId = session.state.sessionId;
    await refresher.refresh({
      message: "second",
    });
    await (await session.send({ message: "second" })).result();

    expect(session.state.sessionId).toBe(sessionId);
    const postUrls = requests
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return request.method === "POST" && !pathname.startsWith("/eve/v1/dev/runtime-artifacts");
      })
      .map((request) => new URL(request.url).pathname);
    expect(postUrls).toEqual(["/eve/v1/session", "/eve/v1/session/session-1"]);
  });

  it("keeps the active session eligible when a candidate rebuild fails", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      failedRebuilds: [false, true],
      requests,
      revisions: ["snapshot-a", "snapshot-a"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://127.0.0.1:3000" });
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://127.0.0.1:3000",
    });
    const session = client.session();

    await refresher.refresh({ message: "first" });
    await (await session.send({ message: "first" })).result();
    const sessionId = session.state.sessionId;

    await refresher.refresh({ message: "second" });
    await (await session.send({ message: "second" })).result();

    expect(session.state.sessionId).toBe(sessionId);
    const postUrls = requests
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return request.method === "POST" && !pathname.startsWith("/eve/v1/dev/runtime-artifacts");
      })
      .map((request) => new URL(request.url).pathname);
    expect(postUrls).toEqual(["/eve/v1/session", "/eve/v1/session/session-1"]);
  });

  it("keeps the active local session for input-response resumes after the dev artifact revision changes", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://localhost:3000" });
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://localhost:3000",
    });
    const inputResponses = [{ optionId: "approve", requestId: "request-1" }];
    const session = client.session();

    await refresher.refresh({
      message: "approve a tool",
    });
    await (await session.send({ message: "approve a tool" })).result();
    const sessionId = session.state.sessionId;
    await refresher.refresh({
      inputResponses,
    });
    await (await session.send({ inputResponses })).result();

    expect(session.state.sessionId).toBe(sessionId);

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

describe("createDevelopmentRuntimeArtifactRefresher", () => {
  it("forces a rebuild without replacing an active session after a known source change", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://localhost:3000" });
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://localhost:3000",
    });
    const session = client.session();

    await refresher.refreshIdle({});
    await (await session.send({ message: "first" })).result();
    const sessionId = session.state.sessionId;

    await refresher.refreshAfterSourceChange({});

    expect(session.state.sessionId).toBe(sessionId);
    expect(
      requests.some((request) => {
        const url = new URL(request.url);
        return (
          request.method === "POST" &&
          url.pathname === "/eve/v1/dev/runtime-artifacts/rebuild" &&
          url.searchParams.get("force") === "1"
        );
      }),
    ).toBe(true);
  });

  it("keeps an active session after a known source change without a baseline revision", async () => {
    const fetchMock = createDevFetchMock({
      requests: [],
      revisions: ["snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new Client({ host: "http://localhost:3000" });
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://localhost:3000",
    });
    const session = client.session();

    await (await session.send({ message: "first" })).result();
    const sessionId = session.state.sessionId;

    await refresher.refreshAfterSourceChange({});

    expect(session.state.sessionId).toBe(sessionId);
  });

  it("reports local dev artifact revision changes for normal prompts", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchMock = createDevFetchMock({
      requests,
      revisions: ["snapshot-a", "snapshot-b"],
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://localhost:3000",
    });
    const changes: Array<{ previousRevision: string; revision: string }> = [];
    await refresher.refresh({
      message: "first",
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
    });
    await refresher.refresh({
      message: "second",
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
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
    const refresher = createDevelopmentRuntimeArtifactRefresher({
      serverUrl: "http://localhost:3000",
    });
    const changes: Array<{ previousRevision: string; revision: string }> = [];
    await refresher.refreshIdle({
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
    });
    await refresher.refreshIdle({
      onRuntimeArtifactsChanged: (change) => {
        changes.push(change);
      },
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
  readonly failedRebuilds?: readonly boolean[];
  readonly requests: Array<{ method: string; url: string }>;
  readonly revisions: readonly string[];
}) {
  let nextRebuildIndex = 0;
  let nextRevisionIndex = 0;
  let nextSessionIndex = 0;

  return vi.fn(async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = resolveRequestUrl(request);
    const method = init?.method ?? "GET";
    input.requests.push({ method, url });

    const pathname = new URL(url).pathname;
    if (pathname === "/eve/v1/dev/runtime-artifacts/rebuild") {
      const rebuildFailed = input.failedRebuilds?.[nextRebuildIndex] === true;
      nextRebuildIndex += 1;
      if (rebuildFailed) {
        return new Response(null, { status: 500 });
      }
    }

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
      const sessionId =
        pathname === "/eve/v1/session"
          ? `session-${String(++nextSessionIndex)}`
          : (pathname.split("/").at(-1) ?? `session-${String(++nextSessionIndex)}`);
      return Response.json({
        continuationToken: `token-${sessionId}`,
        sessionId,
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
