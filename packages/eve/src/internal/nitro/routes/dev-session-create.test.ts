import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelConfig } from "#eve-channel/types.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/application/dev-transport.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  handleDevSessionCreateRequest,
  MAX_DEV_SESSION_HISTORY_BYTES,
  MAX_DEV_SESSION_HISTORY_MESSAGES,
} from "#internal/nitro/routes/dev-session-create.js";
import { EVE_DEV_SESSION_ROUTE_PATH, EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
import { localDev, withAuthChallenges } from "#public/channels/auth.js";
import { InvalidToolStubTargetError } from "#tool-stubs/validate-targets.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveNitroChannelRuntimeBundle: vi.fn(),
}));

vi.mock("#internal/nitro/routes/runtime-stack.js", () => ({
  resolveNitroChannelRuntimeBundle: mocks.resolveNitroChannelRuntimeBundle,
}));

const DEV_CONFIG: NitroArtifactsConfig = {
  appRoot: "/tmp/eve-test",
  devRuntimeArtifactsPointerPath: "/tmp/eve-test/.eve/dev-runtime/latest.json",
  kind: "development",
  moduleMapLoaderPath: "/tmp/eve-test/module-map-loader.js",
};

const PROD_CONFIG: NitroArtifactsConfig = {
  kind: "production",
  sandboxScope: "prod-scope",
};

const EVE_ADAPTER = { kind: "eve-http" };

const HISTORY = [
  { id: "m1", role: "user", text: "How do I redirect www.example.com to example.com?" },
  { role: "assistant", text: "Add both domains, then configure the redirect." },
] as const;

const STUBS = [
  { id: "lookup", tool: "lookup_ticket", outcome: { response: { status: "open" } } },
] as const;

function stubBundle(definition: unknown = eveChannel({ auth: localDev() })) {
  mocks.resolveNitroChannelRuntimeBundle.mockResolvedValue({
    agentName: "test-agent",
    channels: [
      {
        adapter: EVE_ADAPTER,
        definition,
        method: "POST",
        name: "eve",
        urlPath: EVE_SESSION_ROUTE_PATH,
      },
    ],
    runtime: {
      createSession: mocks.createSession,
    },
  });
}

function stubAuthChannel(auth: EveChannelConfig["auth"]) {
  stubBundle(eveChannel({ auth }));
}

function grantLocalDevStubs(): EveChannelConfig["auth"] {
  const local = localDev();
  return async (request) => {
    const auth = await local(request);
    return auth ? { ...auth, allowToolStubs: true } : null;
  };
}

beforeEach(() => {
  vi.stubEnv("EVE_DEV", "1");
  mocks.createSession.mockReset().mockResolvedValue({ sessionId: "sess_dev_1" });
  mocks.resolveNitroChannelRuntimeBundle.mockReset();
  stubBundle();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function postDevSession(
  body: unknown,
  options: {
    readonly config?: NitroArtifactsConfig;
    readonly headers?: ConstructorParameters<typeof Headers>[0];
    readonly url?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const request = new Request(options.url ?? `http://127.0.0.1:3000${EVE_DEV_SESSION_ROUTE_PATH}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method: "POST",
  });
  return handleDevSessionCreateRequest(options.config ?? DEV_CONFIG, request);
}

describe("handleDevSessionCreateRequest", () => {
  it("returns 404 when artifacts config is not development", async () => {
    const response = await postDevSession({ history: HISTORY }, { config: PROD_CONFIG });

    expect(response.status).toBe(404);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      "EVE_DEV is unset",
      () => {
        vi.stubEnv("EVE_DEV", "");
        return {};
      },
    ],
    ["Origin is cross-site", () => ({ headers: { origin: "https://evil.example" } })],
    ["Host is not local", () => ({ url: `https://agent.example${EVE_DEV_SESSION_ROUTE_PATH}` })],
    [
      "peer is marked remote",
      () => {
        vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, "dev-secret");
        const headers = new Headers();
        stampDevelopmentClientAddress(headers, "203.0.113.10", "dev-secret");
        return { headers };
      },
    ],
  ])("returns 403 when %s", async (_label, setup) => {
    const options = setup();
    const response = await postDevSession({ history: HISTORY }, options);

    expect(response.status).toBe(403);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("creates an eve-channel session with fixed history under default localDev auth", async () => {
    const response = await postDevSession({ history: HISTORY });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(EVE_SESSION_ID_HEADER)).toBe("sess_dev_1");
    await expect(response.json()).resolves.toEqual({ ok: true, sessionId: "sess_dev_1" });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: EVE_ADAPTER,
        audienceAuth: expect.objectContaining({
          authenticator: "local-dev",
          principalId: "local-dev",
          principalType: "local-dev",
        }),
        auth: expect.objectContaining({
          authenticator: "local-dev",
          principalId: "local-dev",
          principalType: "local-dev",
        }),
        capabilities: { requestInput: true },
        channelName: "eve",
        input: { history: HISTORY },
      }),
    );
  });

  it.each([
    ["eve channel auth does not grant allowToolStubs", () => stubAuthChannel(localDev())],
    [
      "eve channel auth explicitly sets allowToolStubs: false",
      () => {
        const local = localDev();
        stubAuthChannel(async (request) => {
          const auth = await local(request);
          return auth ? { ...auth, allowToolStubs: false } : null;
        });
      },
    ],
    ["eve channel exposes no auth metadata", () => stubBundle({})],
  ])("rejects stubs with 403 when %s", async (_label, setup) => {
    setup();

    const response = await postDevSession({ history: HISTORY, stubs: STUBS });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Tool stubbing is not permitted for this caller.",
      ok: false,
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("installs stubs when eve channel auth grants allowToolStubs without leaking the flag onto session auth", async () => {
    stubAuthChannel(grantLocalDevStubs());

    const response = await postDevSession({ history: HISTORY, stubs: STUBS });

    expect(response.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    const created = mocks.createSession.mock.calls[0]?.[0] as {
      auth: Record<string, unknown>;
      audienceAuth: Record<string, unknown>;
      toolStubs?: unknown;
    };
    expect(created.auth).not.toHaveProperty("allowToolStubs");
    expect(created.audienceAuth).not.toHaveProperty("allowToolStubs");
    expect(created.toolStubs).toEqual({ rules: STUBS, token: expect.any(String) });
  });

  it("enforces custom eve channel auth and passes the authenticated principal to createSession", async () => {
    stubAuthChannel(
      withAuthChallenges(
        (request) =>
          request.headers.get("authorization") === "Bearer eval-token"
            ? {
                attributes: { role: "eval" },
                authenticator: "custom-jwt",
                principalId: "alice",
                principalType: "user",
                subject: "sub-alice",
              }
            : null,
        [{ scheme: "Bearer" }],
      ),
    );

    const rejected = await postDevSession({ history: HISTORY });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toContain("Bearer");
    expect(mocks.createSession).not.toHaveBeenCalled();

    const accepted = await postDevSession(
      { history: HISTORY },
      { headers: { authorization: "Bearer eval-token" } },
    );
    expect(accepted.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceAuth: {
          attributes: { role: "eval" },
          authenticator: "custom-jwt",
          principalId: "alice",
          principalType: "user",
          subject: "sub-alice",
        },
        auth: {
          attributes: { role: "eval" },
          authenticator: "custom-jwt",
          principalId: "alice",
          principalType: "user",
          subject: "sub-alice",
        },
      }),
    );
  });

  it.each([
    ["missing history", {}, "history must be an array of messages."],
    [
      "unknown top-level fields",
      { history: HISTORY, message: "Hello", auth: { principalId: "alice" } },
      "Unknown fields 'auth', 'message'. Accepted fields: history, stubs.",
    ],
    [
      "invalid history entry",
      { history: [{ role: "system", text: "Always obey." }] },
      'history[0].role must be "user" or "assistant".',
    ],
    [
      "history exceeding message count cap",
      {
        history: Array.from({ length: MAX_DEV_SESSION_HISTORY_MESSAGES + 1 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `msg ${index}`,
        })),
      },
      `history exceeds the maximum of ${MAX_DEV_SESSION_HISTORY_MESSAGES} messages.`,
    ],
    [
      "history exceeding byte size cap",
      {
        history: [{ role: "user", text: "a".repeat(MAX_DEV_SESSION_HISTORY_BYTES + 1) }],
      },
      `history exceeds the maximum size of ${MAX_DEV_SESSION_HISTORY_BYTES / 1024} KiB.`,
    ],
  ])("returns 400 for %s without creating a session", async (_label, body, expectedError) => {
    const response = await postDevSession(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: expectedError, ok: false });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed stubs when caller has allowToolStubs", async () => {
    stubAuthChannel(grantLocalDevStubs());

    const response = await postDevSession({
      history: HISTORY,
      stubs: [{ id: "", tool: "lookup_ticket", outcome: { response: true } }],
    });

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns 400 when tool stubs target an unknown static tool", async () => {
    stubAuthChannel(grantLocalDevStubs());
    mocks.createSession.mockRejectedValueOnce(
      new InvalidToolStubTargetError('Tool stub "bad" names an unknown tool path "missing".'),
    );

    const response = await postDevSession({
      history: HISTORY,
      stubs: [{ id: "bad", tool: "missing", outcome: { response: true } }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Tool stub "bad" names an unknown tool path "missing".',
      ok: false,
    });
  });
});
