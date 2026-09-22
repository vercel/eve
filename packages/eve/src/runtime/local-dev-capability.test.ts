import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_DEV_INTERACTIVE_CLIENT_HEADER,
  getLocalDevCapability,
  installLocalDevCapabilityEnvironment,
  withLocalDevRequestScope,
} from "#runtime/local-dev-capability.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";

const APP_ROOT = "/workspace/agent";
const SERVER_URL = "http://127.0.0.1:3000";

function environment(): Record<string, string> {
  return {
    EVE_DEV_APP_ROOT: APP_ROOT,
    EVE_DEV_CONTROL_URL: SERVER_URL,
  };
}

async function withClient<T>(
  address: string,
  callback: () => Promise<T> | T,
  interactiveClient = false,
): Promise<T> {
  const secret = "test-secret";
  const headers = new Headers();
  stampDevelopmentClientAddress(headers, address, secret);
  if (interactiveClient) headers.set(LOCAL_DEV_INTERACTIVE_CLIENT_HEADER, "1");
  const previousSecret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = secret;
  try {
    return await withLocalDevRequestScope(
      new Request(SERVER_URL, { headers }),
      async () => await callback(),
    );
  } finally {
    if (previousSecret === undefined) delete process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
    else process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = previousSecret;
  }
}

describe("installLocalDevCapabilityEnvironment", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("publishes the authored app root and control origin, and restores them", () => {
    delete process.env.EVE_DEV_APP_ROOT;
    delete process.env.EVE_DEV_CONTROL_URL;

    const restore = installLocalDevCapabilityEnvironment({
      appRoot: APP_ROOT,
      serverUrl: `${SERVER_URL}/`,
    });

    expect(process.env.EVE_DEV_APP_ROOT).toBe(APP_ROOT);
    expect(process.env.EVE_DEV_CONTROL_URL).toBe(SERVER_URL);

    restore();

    expect(process.env.EVE_DEV_APP_ROOT).toBeUndefined();
    expect(process.env.EVE_DEV_CONTROL_URL).toBeUndefined();
  });
});

describe("getLocalDevCapability", () => {
  it("is absent without both host facilities", () => {
    expect(getLocalDevCapability({})).toBeUndefined();
    expect(getLocalDevCapability({ EVE_DEV_APP_ROOT: APP_ROOT })).toBeUndefined();
    expect(getLocalDevCapability({ EVE_DEV_CONTROL_URL: SERVER_URL })).toBeUndefined();
    expect(
      getLocalDevCapability({ EVE_DEV_APP_ROOT: "", EVE_DEV_CONTROL_URL: SERVER_URL }),
    ).toBeUndefined();
    expect(
      getLocalDevCapability({ EVE_DEV_APP_ROOT: APP_ROOT, EVE_DEV_CONTROL_URL: "" }),
    ).toBeUndefined();
  });

  it("is available on a host with both facilities without a request scope", () => {
    expect(getLocalDevCapability(environment())).toMatchObject({
      appRoot: APP_ROOT,
      interactiveClient: false,
    });
  });

  it("does not make source access depend on the peer address or provenance", async () => {
    await withClient("127.0.0.1", () => {
      expect(getLocalDevCapability(environment())?.interactiveClient).toBe(false);
    });
    await withClient("203.0.113.7", () => {
      expect(getLocalDevCapability(environment())).toMatchObject({
        appRoot: APP_ROOT,
        interactiveClient: false,
      });
    });

    await withLocalDevRequestScope(new Request(SERVER_URL), async () => {
      expect(getLocalDevCapability(environment())).toMatchObject({
        appRoot: APP_ROOT,
        interactiveClient: false,
      });
    });
  });

  it("inherits a verified dev-TUI hint into nested authored execution contexts", async () => {
    await withClient(
      "127.0.0.1",
      async () => {
        const nestedContext = new ContextContainer();
        await contextStorage.run(nestedContext, () => {
          expect(getLocalDevCapability(environment())).toMatchObject({
            appRoot: APP_ROOT,
            interactiveClient: true,
          });
        });
      },
      true,
    );
  });

  it("keeps source access while a direct remote request clears the dev-TUI hint", async () => {
    await withClient(
      "127.0.0.1",
      async () => {
        expect(getLocalDevCapability(environment())?.interactiveClient).toBe(true);
        await withClient("203.0.113.7", () => {
          expect(getLocalDevCapability(environment())).toMatchObject({
            appRoot: APP_ROOT,
            interactiveClient: false,
          });
        });
        expect(getLocalDevCapability(environment())?.interactiveClient).toBe(true);
      },
      true,
    );
  });

  it("preserves a verified dev-TUI hint through durable context serialization", async () => {
    await withClient(
      "127.0.0.1",
      async () => {
        const active = contextStorage.getStore();
        expect(active).toBeDefined();
        const restored = await deserializeContext(serializeContext(active!));

        await contextStorage.run(restored, () => {
          expect(getLocalDevCapability(environment())).toMatchObject({
            appRoot: APP_ROOT,
            interactiveClient: true,
          });
        });
      },
      true,
    );
  });

  it("invalidates a rotated or tampered dev-TUI hint without revoking source access", async () => {
    await withClient(
      "127.0.0.1",
      async () => {
        const active = contextStorage.getStore();
        expect(active).toBeDefined();
        const serialized = serializeContext(active!);
        const restored = await deserializeContext(serialized);
        process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = "replacement-secret";

        await contextStorage.run(restored, () => {
          expect(getLocalDevCapability(environment())).toMatchObject({
            appRoot: APP_ROOT,
            interactiveClient: false,
          });
        });

        serialized["eve.internal.localDevRequest"] = {
          address: "127.0.0.1",
          interactiveClient: true,
          signature: "forged",
        };
        const tampered = await deserializeContext(serialized);
        await contextStorage.run(tampered, () => {
          expect(getLocalDevCapability(environment())).toMatchObject({
            appRoot: APP_ROOT,
            interactiveClient: false,
          });
        });
      },
      true,
    );
  });

  it("reports whether a verified originating local client is interactive", async () => {
    await withClient("::1", () => {
      expect(getLocalDevCapability(environment())?.interactiveClient).toBe(false);
    });
    await withClient(
      "::1",
      () => {
        expect(getLocalDevCapability(environment())?.interactiveClient).toBe(true);
      },
      true,
    );
  });
});

describe("withSuspendedSource", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function requestedPaths(): string[] {
    return fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
  }

  it("suspends the watcher around host-side work and resumes it afterwards", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ revision: "r2" }), { status: 200 }));
    const order: string[] = [];
    const result = await getLocalDevCapability(environment())!.withSuspendedSource(async () => {
      order.push(...requestedPaths());
      return "installed";
    });

    expect(result).toBe("installed");
    expect(order).toEqual(["/eve/v1/dev/runtime-artifacts/suspend"]);
    expect(requestedPaths()).toEqual([
      "/eve/v1/dev/runtime-artifacts/suspend",
      "/eve/v1/dev/runtime-artifacts/resume",
    ]);
  });

  it("resumes even when the task throws", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ revision: "r2" }), { status: 200 }));
    await expect(
      getLocalDevCapability(environment())!.withSuspendedSource(async () => {
        throw new Error("install failed");
      }),
    ).rejects.toThrow("install failed");

    expect(requestedPaths()).toEqual([
      "/eve/v1/dev/runtime-artifacts/suspend",
      "/eve/v1/dev/runtime-artifacts/resume",
    ]);
  });

  it("refuses to run the task when the watcher cannot be suspended", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const task = vi.fn();

    await expect(getLocalDevCapability(environment())!.withSuspendedSource(task)).rejects.toThrow(
      /Could not pause the eve development server/u,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("retries the same lease when the first resume request does not reach the host", async () => {
    let resumeCalls = 0;
    fetchMock.mockImplementation((input: string | URL) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith("/resume") && resumeCalls++ === 0) {
        return Promise.reject(new Error("connection reset"));
      }
      return Promise.resolve(new Response(JSON.stringify({ revision: "r2" }), { status: 200 }));
    });

    await getLocalDevCapability(environment())!.withSuspendedSource(async () => undefined);

    expect(requestedPaths()).toEqual([
      "/eve/v1/dev/runtime-artifacts/suspend",
      "/eve/v1/dev/runtime-artifacts/resume",
      "/eve/v1/dev/runtime-artifacts/resume",
    ]);
    const leases = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("lease"),
    );
    expect(new Set(leases).size).toBe(1);
  });
});
