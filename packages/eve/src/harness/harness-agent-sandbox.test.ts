import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withRuntimeSandboxLifecycle } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { registerVercelSandboxForSandboxSession } from "#execution/sandbox/bindings/vercel-session-registry.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { loadHarnessAgentSandboxSession } from "./harness-agent-sandbox.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadWithAccess(access?: SandboxAccess) {
  const ctx = new ContextContainer();
  if (access !== undefined) {
    ctx.set(SandboxKey, access);
  }
  return await contextStorage.run(ctx, loadHarnessAgentSandboxSession);
}

function createRegisteredSandbox() {
  const eveSandbox = mockSandbox({ id: "eve-session" });
  const routes = [{ port: 3000 }, { port: 4000 }];
  const update = vi.fn(async () => {});
  const vercelSandbox: VercelSandbox = Object.assign(Object.create(null), {
    currentSession: () => ({ networkPolicy: "allow-all" }),
    domain: vi.fn((port: number) => `https://${port}.example.test`),
    name: "vercel-session",
    routes,
    update,
  });

  registerVercelSandboxForSandboxSession({
    sandbox: vercelSandbox,
    session: eveSandbox.session,
  });

  return { eveSandbox, routes, update, vercelSandbox };
}

describe("loadHarnessAgentSandboxSession", () => {
  it("rejects execution without an active sandbox", async () => {
    await expect(loadWithAccess()).rejects.toThrow(
      "Harness-backed agents require an active sandbox.",
    );

    const sandbox = mockSandbox();
    await expect(
      loadWithAccess({
        ...sandbox.access,
        get: async () => null,
      }),
    ).rejects.toThrow("Harness-backed agents require an active sandbox.");
  });

  it("rejects non-Vercel sandbox backends", async () => {
    await expect(loadWithAccess(mockSandbox().access)).rejects.toThrow(
      "Harness-backed agents currently require the Vercel sandbox backend.",
    );
  });

  it("adapts the registered Vercel sandbox with live read-only network metadata", async () => {
    const { eveSandbox, routes } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);

    expect(session.id).toBe("vercel-session");
    expect(session.defaultWorkingDirectory).toBe("/workspace");
    expect(session.description).toBe(
      [
        "Vercel Sandbox (name: vercel-session).",
        "The default working directory is /workspace.",
        "Filesystem changes persist for the lifetime of the sandbox.",
      ].join("\n"),
    );
    expect(session.ports).toEqual([3000, 4000]);

    routes.push({ port: 5000 });
    expect(session.ports).toEqual([3000, 4000, 5000]);
    expect(session).not.toHaveProperty("setPorts");
  });

  it("resolves the registered Vercel sandbox through lifecycle wrappers", async () => {
    const { eveSandbox } = createRegisteredSandbox();
    const wrapped = withRuntimeSandboxLifecycle(
      eveSandbox.session,
      async () => {},
      async () => {},
    );
    const nested = withRuntimeSandboxLifecycle(
      wrapped,
      async () => {},
      async () => {},
    );

    await expect(
      loadWithAccess({ ...eveSandbox.access, get: async () => wrapped }),
    ).resolves.toMatchObject({ id: "vercel-session", ports: [3000, 4000] });
    await expect(
      loadWithAccess({ ...eveSandbox.access, get: async () => nested }),
    ).resolves.toMatchObject({ id: "vercel-session", ports: [3000, 4000] });
  });

  it.each([
    { expected: "https://3000.example.test/", protocol: undefined },
    { expected: "https://3000.example.test/", protocol: "http" as const },
    { expected: "https://3000.example.test/", protocol: "https" as const },
    { expected: "wss://3000.example.test/", protocol: "ws" as const },
  ])("resolves $protocol endpoints", async ({ expected, protocol }) => {
    const { eveSandbox, vercelSandbox } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);

    await expect(session.getPortEndpoint({ port: 3000, protocol })).resolves.toEqual({
      url: expected,
    });
    expect(vercelSandbox.domain).toHaveBeenCalledWith(3000);
  });

  it("preserves insecure HTTP and WebSocket endpoints", async () => {
    const { eveSandbox, vercelSandbox } = createRegisteredSandbox();
    vi.mocked(vercelSandbox.domain).mockReturnValue("http://localhost:3000");
    const session = await loadWithAccess(eveSandbox.access);

    await expect(session.getPortEndpoint({ port: 3000, protocol: "http" })).resolves.toEqual({
      url: "http://localhost:3000/",
    });
    await expect(session.getPortEndpoint({ port: 3000, protocol: "ws" })).resolves.toEqual({
      url: "ws://localhost:3000/",
    });
  });

  it("rejects ports that are not exposed", async () => {
    const { eveSandbox } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);

    await expect(session.getPortEndpoint({ port: 9999 })).rejects.toMatchObject({
      harnessId: "vercel-sandbox",
      message: "Port 9999 is not exposed on this sandbox. Exposed ports: [3000, 4000].",
      name: "AI_HarnessCapabilityUnsupportedError",
    });
  });

  it("keeps getPortUrl as a URL-only wrapper", async () => {
    const { eveSandbox } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);

    await expect(session.getPortUrl({ port: 4000, protocol: "ws" })).resolves.toBe(
      "wss://4000.example.test/",
    );
  });

  it("adds request transformations through the Vercel network policy", async () => {
    const { eveSandbox, update } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);

    await session.addRequestTransformations?.([
      {
        match: {
          headers: [
            {
              key: { exact: "x-api-key" },
              value: { exact: "sandbox-placeholder" },
            },
          ],
          host: "ai-gateway.vercel.sh",
          method: ["POST"],
          path: { startsWith: "/v1/" },
        },
        transform: {
          headers: { "x-api-key": "real-credential" },
        },
      },
    ]);

    expect(update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "ai-gateway.vercel.sh": [
            {
              match: {
                headers: [
                  {
                    key: { exact: "x-api-key" },
                    value: { exact: "sandbox-placeholder" },
                  },
                ],
                method: ["POST"],
                path: { startsWith: "/v1/" },
              },
              transform: [{ headers: { "x-api-key": "real-credential" } }],
            },
          ],
        },
      },
    });
  });

  it("returns only the AI SDK I/O surface from restricted", async () => {
    const { eveSandbox } = createRegisteredSandbox();
    const session = await loadWithAccess(eveSandbox.access);
    const restricted = session.restricted();

    expect(Object.keys(restricted).sort()).toEqual(
      [
        "description",
        "readBinaryFile",
        "readFile",
        "readTextFile",
        "run",
        "spawn",
        "writeBinaryFile",
        "writeFile",
        "writeTextFile",
      ].sort(),
    );
    expect(restricted.run).toBe(eveSandbox.session.run);
    expect(restricted).not.toHaveProperty("removePath");
    expect(restricted).not.toHaveProperty("resolvePath");
    expect(restricted).not.toHaveProperty("addRequestTransformations");
    expect(restricted).not.toHaveProperty("setNetworkPolicy");
  });

  it("does not take ownership of the eve sandbox lifecycle", async () => {
    const stop = vi.fn();
    const destroy = vi.fn();
    const eveSandbox = mockSandbox({ stop });
    const vercelSandbox: VercelSandbox = Object.assign(Object.create(null), {
      delete: destroy,
      domain: vi.fn((port: number) => `https://${port}.example.test`),
      name: "vercel-session",
      routes: [{ port: 3000 }],
      stop,
    });
    registerVercelSandboxForSandboxSession({
      sandbox: vercelSandbox,
      session: eveSandbox.session,
    });
    const session = await loadWithAccess(eveSandbox.access);

    await session.stop();
    await session.destroy();

    expect(stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});
