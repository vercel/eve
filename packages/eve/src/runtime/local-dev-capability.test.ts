import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  localDevInteractiveClientEnvironment,
  getLocalDevCapability,
  installLocalDevCapabilityEnvironment,
} from "#runtime/local-dev-capability.js";

const APP_ROOT = "/workspace/agent";
const SERVER_URL = "http://127.0.0.1:3000";

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    EVE_DEV_APP_ROOT: APP_ROOT,
    EVE_DEV_CONTROL_URL: SERVER_URL,
    ...overrides,
  };
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

describe("localDevInteractiveClientEnvironment", () => {
  it("declares the flag only for a terminal owner running the TUI", () => {
    expect(localDevInteractiveClientEnvironment(true)).toEqual({
      EVE_DEV_INTERACTIVE_CLIENT: "1",
    });
    expect(localDevInteractiveClientEnvironment(false)).toEqual({});
  });
});

describe("getLocalDevCapability", () => {
  it("is absent when the dev host published nothing", () => {
    expect(getLocalDevCapability({})).toBeUndefined();
    expect(getLocalDevCapability({ EVE_DEV_APP_ROOT: APP_ROOT })).toBeUndefined();
    expect(getLocalDevCapability({ EVE_DEV_CONTROL_URL: SERVER_URL })).toBeUndefined();
  });

  it("reports the authored app root rather than a runtime snapshot", () => {
    expect(getLocalDevCapability(environment())?.appRoot).toBe(APP_ROOT);
  });

  it("reports an interactive client only when the terminal owner declared one", () => {
    expect(getLocalDevCapability(environment())?.interactiveClient).toBe(false);
    expect(
      getLocalDevCapability(environment({ EVE_DEV_INTERACTIVE_CLIENT: "1" }))?.interactiveClient,
    ).toBe(true);
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

  it("suspends the watcher around the task and resumes it afterwards", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ revision: "r2" }), { status: 200 }));
    const capability = getLocalDevCapability(environment());

    const order: string[] = [];
    const result = await capability?.withSuspendedSource(async () => {
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
    const capability = getLocalDevCapability(environment());

    await expect(
      capability?.withSuspendedSource(async () => {
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
    const capability = getLocalDevCapability(environment());
    const task = vi.fn();

    await expect(capability?.withSuspendedSource(task)).rejects.toThrow(
      /Could not pause the eve development server/u,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("forces a rebuild when the resume could not be served", async () => {
    fetchMock.mockImplementation((input: string | URL) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith("/resume")) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify({ revision: "r2" }), { status: 200 }));
    });
    const capability = getLocalDevCapability(environment());

    await capability?.withSuspendedSource(async () => undefined);

    expect(requestedPaths()).toEqual([
      "/eve/v1/dev/runtime-artifacts/suspend",
      "/eve/v1/dev/runtime-artifacts/resume",
      "/eve/v1/dev/runtime-artifacts/rebuild",
    ]);
  });
});
