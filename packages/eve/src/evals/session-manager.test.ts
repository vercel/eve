import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { ClientError } from "#client/client-error.js";
import { EvalSessionManager } from "#evals/session-manager.js";
import { EVE_DEV_SESSION_ROUTE_PATH, EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const HISTORY = [
  { id: "q1", role: "user", text: "How do I redirect www.example.com to example.com?" },
  { role: "assistant", text: "Add both domains, then configure the redirect." },
] as const satisfies readonly SessionHistoryMessage[];

function stubFetch(
  handler: (input: {
    readonly body: unknown;
    readonly headers: Headers;
    readonly method: string;
    readonly pathname: string;
  }) => Response,
) {
  const requests: Array<{
    readonly body: unknown;
    readonly headers: Headers;
    readonly method: string;
    readonly pathname: string;
  }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    const entry = {
      body: init?.body == null ? undefined : JSON.parse(String(init.body)),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      pathname: url.pathname,
    };
    requests.push(entry);
    return handler(entry);
  });
  return requests;
}

describe("EvalSessionManager.session", () => {
  it("uses /eve/v1/session when history is omitted", async () => {
    const requests = stubFetch(() =>
      Response.json({ ok: true, sessionId: "sess_prod" }, { status: 202 }),
    );
    const manager = new EvalSessionManager({
      client: new Client({ baseUrl: "http://127.0.0.1:3000" }),
      devRoutes: false,
    });

    const session = await manager.session();

    expect(session.id).toBe("sess_prod");
    expect(requests.map(({ method, pathname, body }) => ({ method, pathname, body }))).toEqual([
      { body: undefined, method: "POST", pathname: EVE_SESSION_ROUTE_PATH },
    ]);
  });

  it("rejects history before making any HTTP request when devRoutes is disabled", async () => {
    const requests = stubFetch(() =>
      Response.json({ ok: true, sessionId: "nope" }, { status: 202 }),
    );
    const manager = new EvalSessionManager({
      client: new Client({ baseUrl: "https://agent.example" }),
      devRoutes: false,
    });

    await expect(manager.session({ history: HISTORY })).rejects.toThrow(/dev routes enabled/i);
    expect(requests).toEqual([]);
  });

  it("creates a seeded session via /eve/v1/dev/session and tracks stubs for verification", async () => {
    const stubs = [
      { id: "lookup", tool: "lookup_ticket", outcome: { response: { status: "open" } } },
    ] as const;
    const requests = stubFetch(({ pathname }) => {
      if (pathname === EVE_DEV_SESSION_ROUTE_PATH) {
        return Response.json({ ok: true, sessionId: "sess_seeded" }, { status: 202 });
      }
      if (pathname === "/eve/v1/session/sess_seeded/stubs") {
        return Response.json({ error: null, matchedRuleIds: ["lookup"] }, { status: 200 });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });
    const manager = new EvalSessionManager({
      client: new Client({ baseUrl: "http://127.0.0.1:3000" }),
      devRoutes: true,
    });

    const session = await manager.session({
      headers: { "x-eval-case": "redirect" },
      history: HISTORY,
      stubs,
    });
    await manager.verifyStubs();

    expect(session.id).toBe("sess_seeded");
    expect(requests[0]?.pathname).toBe(EVE_DEV_SESSION_ROUTE_PATH);
    expect(requests[0]?.body).toEqual({ history: HISTORY, stubs });
    expect(requests[0]?.headers.get("x-eval-case")).toBe("redirect");
    expect(requests[1]?.pathname).toBe("/eve/v1/session/sess_seeded/stubs");
  });

  it("throws ClientError when /eve/v1/dev/session rejects invalid history", async () => {
    stubFetch(() =>
      Response.json(
        { error: 'history[0].role must be "user" or "assistant".', ok: false },
        { status: 400 },
      ),
    );
    const manager = new EvalSessionManager({
      client: new Client({ baseUrl: "http://127.0.0.1:3000" }),
      devRoutes: true,
    });

    const error = await manager
      .session({ history: [{ role: "system", text: "Hi" }] as never })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).status).toBe(400);
    expect((error as ClientError).message).toBe('history[0].role must be "user" or "assistant".');
  });

  it("serializes Uint8Array and URL file parts in history before posting to /eve/v1/dev/session", async () => {
    const requests = stubFetch(() =>
      Response.json({ ok: true, sessionId: "sess_files" }, { status: 202 }),
    );
    const manager = new EvalSessionManager({
      client: new Client({ baseUrl: "http://127.0.0.1:3000" }),
      devRoutes: true,
    });

    await manager.session({
      history: [
        {
          parts: [
            { text: "See attached.", type: "text" },
            {
              data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
              filename: "contract.pdf",
              mediaType: "application/pdf",
              type: "file",
            },
            {
              data: new URL("https://example.com/terms.pdf"),
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
    });

    expect(requests[0]?.body).toEqual({
      history: [
        {
          parts: [
            { text: "See attached.", type: "text" },
            {
              data: "data:application/pdf;base64,JVBERg==",
              filename: "contract.pdf",
              mediaType: "application/pdf",
              type: "file",
            },
            {
              data: "https://example.com/terms.pdf",
              mediaType: "application/pdf",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
    });
  });
});
