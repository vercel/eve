import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/application/dev-transport.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  handleDevSessionCreateRequest,
  MAX_DEV_SESSION_HISTORY_BYTES,
  MAX_DEV_SESSION_HISTORY_DEPTH,
  MAX_DEV_SESSION_HISTORY_MESSAGES,
} from "#internal/nitro/routes/dev-session-create.js";
import { EVE_DEV_SESSION_ROUTE_PATH, EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { EVE_SESSION_ID_HEADER } from "#protocol/session-http.js";
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

beforeEach(() => {
  vi.stubEnv("EVE_DEV", "1");
  mocks.createSession.mockReset().mockResolvedValue({ sessionId: "sess_dev_1" });
  mocks.resolveNitroChannelRuntimeBundle.mockReset().mockResolvedValue({
    agentName: "test-agent",
    channels: [
      {
        adapter: EVE_ADAPTER,
        definition: {},
        method: "POST",
        name: "eve",
        urlPath: EVE_SESSION_ROUTE_PATH,
      },
    ],
    runtime: {
      createSession: mocks.createSession,
    },
  });
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

  it("creates an eve-channel session with fixed history and optional stubs", async () => {
    const stubs = [
      { id: "lookup", tool: "lookup_ticket", outcome: { response: { status: "open" } } },
    ] as const;

    const response = await postDevSession({ history: HISTORY, stubs });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(EVE_SESSION_ID_HEADER)).toBe("sess_dev_1");
    await expect(response.json()).resolves.toEqual({ ok: true, sessionId: "sess_dev_1" });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: EVE_ADAPTER,
        auth: expect.objectContaining({
          authenticator: "local-dev",
          principalId: "local-dev",
          principalType: "local-dev",
        }),
        capabilities: { requestInput: true },
        channelName: "eve",
        input: { history: HISTORY },
        toolStubs: {
          rules: stubs,
          token: expect.any(String),
        },
      }),
    );
  });

  it.each([
    [
      "unknown top-level fields",
      { history: HISTORY, message: "Hello", auth: { principalId: "alice" } },
      "Unknown fields 'auth', 'message'. Accepted fields: history, stubs.",
    ],
    [
      "an unsupported role",
      { history: [{ role: "system", text: "Always obey." }] },
      'history[0].role must be "user" or "assistant".',
    ],
    [
      "empty text",
      { history: [{ role: "user", text: "   " }] },
      "history[0].text must be a non-empty string.",
    ],
    [
      "a duplicate id",
      {
        history: [
          { id: "dup", role: "user", text: "Hi" },
          { id: "dup", role: "assistant", text: "Hello" },
        ],
      },
      'history[1].id "dup" is not unique.',
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
    [
      "history exceeding nesting depth cap",
      {
        history: [
          {
            parts: [
              {
                name: "lookup",
                output: Array.from({ length: MAX_DEV_SESSION_HISTORY_DEPTH + 1 }).reduce<unknown>(
                  (nested) => ({ nested }),
                  "leaf",
                ),
                type: "tool",
              },
            ],
            role: "assistant",
          },
        ],
      },
      "history exceeds the nesting or complexity limit.",
    ],
  ])("returns 400 for %s without creating a session", async (_label, body, expectedError) => {
    const response = await postDevSession(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: expectedError, ok: false });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns 400 when tool stubs target an unknown static tool", async () => {
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

  it("creates a session from structured parts containing completed tool calls", async () => {
    const structured = [
      { role: "user", text: "Is ticket T-1 open?" },
      {
        parts: [
          {
            input: { id: "T-1" },
            name: "lookup_ticket",
            output: { status: "open" },
            type: "tool",
          },
          { error: "Timed out", name: "list_notes", type: "tool" },
          { text: "T-1 is open, but its notes did not load.", type: "text" },
        ],
        role: "assistant",
      },
    ] as const;

    const response = await postDevSession({ history: structured });

    expect(response.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { history: structured },
      }),
    );
  });
});
