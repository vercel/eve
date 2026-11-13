/* oxlint-disable typescript/no-unsafe-type-assertion -- Kernel's page type has private members beyond the AsyncIterable contract consumed by the browser tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
  withBrowserProfileWriteLock,
} from "@db/services/browsers";
import type { recordBrowserTraceDomains } from "@db/services/browser-traces";
import type { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import type { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import type * as TraceDomainsModule from "@agent/subagents/browser-agent/lib/trace/domains";
import type { harvestBrowserTraceDomains } from "@agent/subagents/browser-agent/lib/trace/domains";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { toolContextFor } from "@tests/helpers/tool-context";
import manageBrowsers, {
  kernelProfileNameForWorkspace,
} from "@agent/subagents/browser-agent/tools/manage_browsers";

const serviceMocks = vi.hoisted(() => ({
  createBrowserSession: vi.fn<typeof createBrowserSession>(),
  deleteBrowserSession: vi.fn<typeof deleteBrowserSession>(),
  harvestBrowserTraceDomains: vi.fn<typeof harvestBrowserTraceDomains>(),
  listBrowserSessions: vi.fn<typeof listBrowserSessions>(),
  recordBrowserTraceDomains: vi.fn<typeof recordBrowserTraceDomains>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  withBrowserProfileWriteLock: vi.fn<typeof withBrowserProfileWriteLock>(),
}));

vi.mock("@db/services/browsers", () => ({
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  listBrowserSessions: serviceMocks.listBrowserSessions,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
}));
vi.mock("@db/services/browser-traces", () => ({
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
}));
vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: serviceMocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: serviceMocks.requireOwnedBrowserSession,
}));
vi.mock(
  "@agent/subagents/browser-agent/lib/trace/domains",
  async (importOriginal) => ({
    ...(await importOriginal<typeof TraceDomainsModule>()),
    harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  })
);

vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (update: (current: T) => T) => {
        value = update(value);
      },
    };
  },
}));

const mocks = {
  createBrowser: vi.spyOn(kernel.browsers, "create"),
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowser: vi.spyOn(kernel.browsers, "deleteByID"),
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  listBrowserSessions: serviceMocks.listBrowserSessions,
  listKernelBrowsers: vi.spyOn(kernel.browsers, "list"),
  readBrowserSession: serviceMocks.requireOwnedBrowserSession,
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
  retrieveBrowser: vi.spyOn(kernel.browsers, "retrieve"),
  retrieveProfile: vi.spyOn(kernel.profiles, "retrieve"),
  requireWorkerScope: serviceMocks.requireWorkerScope,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.retrieveProfile.mockResolvedValue({
    created_at: "2026-08-27T00:00:00.000Z",
    id: "profile-1",
    name: "opaque-profile",
  });
  mocks.listKernelBrowsers.mockReturnValue(kernelBrowserPage([]));
  mocks.createBrowser.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1",
    cdp_ws_url: "wss://kernel.test/cdp",
    created_at: "2026-08-27T00:00:00.000Z",
    headless: false,
    memory: "2GiB",
    profile: {
      created_at: "2026-08-27T00:00:00.000Z",
      id: "profile-1",
    },
    profile_save_changes: false,
    region: "us-east",
    session_id: "browser-1",
    stealth: true,
    timeout_seconds: 900,
    webdriver_ws_url: "wss://kernel.test/webdriver",
  });
  mocks.deleteBrowser.mockResolvedValue();
  mocks.createBrowserSession.mockResolvedValue();
  mocks.deleteBrowserSession.mockResolvedValue(true);
  mocks.harvestBrowserTraceDomains.mockResolvedValue();
  mocks.listBrowserSessions.mockResolvedValue([]);
  mocks.readBrowserSession.mockResolvedValue({
    createdAt: "2026-08-27T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.recordBrowserTraceDomains.mockResolvedValue();
  mocks.withBrowserProfileWriteLock.mockImplementation(
    async (_scope, operation) => operation()
  );
});

const workerContext = toolContextFor({ sessionId: "worker-session-1" });

describe("Kernel browser contract", () => {
  it("keeps agent-created browsers alive for at least 15 minutes", () => {
    const inputSchema = manageBrowsers.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("manage_browsers must use a Zod input schema.");
    }

    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 120,
      }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 900,
      }).success
    ).toBe(true);
  });

  it("starts a read-only persistent-profile browser at the target URL", async () => {
    const result = await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/checkout" },
      workerContext
    );

    expect(result).toMatchObject({
      browser: {
        browser_live_view_url: "https://live.kernel.test/browser-1",
      },
    });
    const lifecycle = z
      .object({ next_actions: z.array(z.string()) })
      .parse(result);
    expect(lifecycle.next_actions.join(" ")).toContain("browser_snapshot");
    expect(lifecycle.next_actions.join(" ")).toContain("browser_act");
    expect(lifecycle.next_actions.join(" ")).toContain("playwright_execute");
    expect(lifecycle.next_actions.join(" ")).toContain("relaxed fallback");
    expect(JSON.stringify(result)).not.toContain("execute_playwright_code");
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      {
        profile: { id: "profile-1", save_changes: false },
        start_url: "https://example.com/checkout",
        stealth: true,
        telemetry: { browser: { page: { enabled: true } }, enabled: true },
        timeout_seconds: 900,
        viewport: undefined,
      },
      { maxRetries: 8, signal: workerContext.abortSignal }
    );
    expect(mocks.createBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "browser-1",
        workerSessionId: "worker-session-1",
      }
    );
    expect(mocks.recordBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1",
      ["example.com"]
    );
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
  });

  it("harvests visited domains from Kernel telemetry before deleting a browser", async () => {
    mocks.readBrowserSession.mockResolvedValue({
      createdAt: "2026-08-27T00:00:00.000Z",
      sessionId: "browser-1",
      workerSessionId: "worker-session-9",
    });

    const result = await manageBrowsers.execute(
      { action: "delete", session_id: "browser-1" },
      workerContext
    );

    expect(result).toBe("Browser session deleted successfully");
    expect(mocks.harvestBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-9",
      { createdAt: "2026-08-27T00:00:00.000Z", sessionId: "browser-1" },
      expect.any(AbortSignal)
    );
    expect(
      mocks.harvestBrowserTraceDomains.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.deleteBrowser.mock.invocationCallOrder[0] ?? 0);
  });

  it("allows only one writable profile browser", async () => {
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          profile: { id: "profile-1" },
          profile_save_changes: true,
          session_id: "browser-active",
        },
      ])
    );
    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        toolContextFor()
      )
    ).rejects.toThrow(/browser-active.*saving login state/i);
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledOnce();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("prunes stale owned records when Kernel reports a missing browser", async () => {
    mocks.listBrowserSessions.mockResolvedValue([
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "stale-browser",
      },
    ]);
    mocks.retrieveBrowser.mockRejectedValue({ status: 404 });

    const result = await manageBrowsers.execute(
      { action: "list" },
      toolContextFor()
    );

    expect(result).toEqual({ has_more: false, items: [], next_offset: null });
    expect(mocks.deleteBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "stale-browser"
    );
  });

  it("derives opaque, stable, workspace-specific profile names", () => {
    const workspace = "personal:+15555550123";
    const profileName = kernelProfileNameForWorkspace(workspace);

    expect(profileName).toBe(kernelProfileNameForWorkspace(workspace));
    expect(profileName).toMatch(/^openinstinct-[a-f0-9]{40}$/);
    expect(profileName).not.toContain("15555550123");
    expect(profileName).not.toBe(
      kernelProfileNameForWorkspace("personal:+15555550124")
    );
  });
});

function asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function kernelBrowserPage(items: readonly unknown[]) {
  // SAFETY: manage_browsers consumes only the SDK page's AsyncIterable contract.
  return asyncItems(items) as ReturnType<typeof kernel.browsers.list>;
}
