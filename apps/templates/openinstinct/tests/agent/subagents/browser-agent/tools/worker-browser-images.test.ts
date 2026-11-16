/* oxlint-disable vitest/require-mock-type-parameters -- The test fixtures implement only the external API surface exercised by the tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolContextFor } from "@tests/helpers/tool-context";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const image = {
  byteSize: png.byteLength,
  filename: "Product.png",
  id: artifactId,
  label: "Product",
  mediaType: "image/png" as const,
  url: `/artifacts/${artifactId}`,
};

const mocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  del: vi.fn(),
  deleteFile: vi.fn(),
  fetch: vi.fn(),
  mask: vi.fn(),
  persist: vi.fn(),
  playwrightExecute: vi.fn(),
  readFile: vi.fn(),
  reserve: vi.fn(),
  retrieve: vi.fn(),
  put: vi.fn(),
  requireOwnedBrowserSession: vi.fn(),
  requireWorkerScope: vi.fn(),
}));

vi.mock("@agent/subagents/browser-agent/lib/access", () => ({
  requireWorkerScope: mocks.requireWorkerScope,
}));
vi.mock("@agent/subagents/browser-agent/lib/owned-browser", () => ({
  requireOwnedBrowserSession: mocks.requireOwnedBrowserSession,
}));
vi.mock("@agent/subagents/browser-agent/lib/vault-screenshot-mask", () => ({
  withVaultScreenshotMask: mocks.mask,
}));
vi.mock("@db/services/browser-images", () => ({
  finalizeBrowserImageArtifact: mocks.persist,
  reserveBrowserImageArtifact: mocks.reserve,
}));
vi.mock("@vercel/blob", () => ({
  del: mocks.del,
  put: mocks.put,
}));
vi.mock("@agent/subagents/browser-agent/lib/kernel", () => ({
  kernel: {
    browsers: {
      computer: { captureScreenshot: mocks.captureScreenshot },
      fetch: mocks.fetch,
      fs: { deleteFile: mocks.deleteFile, readFile: mocks.readFile },
      playwright: { execute: mocks.playwrightExecute },
      retrieve: mocks.retrieve,
    },
  },
}));

import captureBrowserImage from "@agent/subagents/browser-agent/tools/capture_browser_image";

const scope = { userId: "user-1", workspaceId: "workspace-1" };
const reservation = {
  id: artifactId,
  storagePathname: `browser-images/workspace/${artifactId}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue(scope);
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-08-31T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.reserve.mockResolvedValue({ reservation, status: "pending" });
  mocks.persist.mockResolvedValue({ image, storagePathname: "stored/image" });
  mocks.del.mockResolvedValue(undefined);
  mocks.put.mockResolvedValue({ pathname: "stored/image" });
  mocks.mask.mockImplementation(
    async (
      _sessionId: string,
      _signal: AbortSignal,
      capture: () => Promise<Uint8Array>
    ) => capture()
  );
  mocks.captureScreenshot.mockResolvedValue(new Response(png));
  mocks.playwrightExecute.mockResolvedValue({ result: true, success: true });
  mocks.readFile.mockResolvedValue(new Response(png));
  mocks.deleteFile.mockResolvedValue(undefined);
  mocks.retrieve.mockResolvedValue({
    cdp_ws_url: "wss://kernel.test/cdp",
    created_at: "2026-08-31T00:00:00.000Z",
    headless: false,
    memory: "2GiB",
    region: "us-east",
    session_id: "browser-1",
    stealth: true,
    timeout_seconds: 900,
    webdriver_ws_url: "wss://kernel.test/webdriver",
  });
  mocks.fetch.mockResolvedValue(
    new Response(png, { headers: { "content-type": "image/png" } })
  );
});

describe("capture_browser_image", () => {
  it("captures a masked viewport and returns only the artifact descriptor", async () => {
    const toolContext = context();
    const result = await captureBrowserImage.execute(
      {
        label: "Product",
        region: { height: 200, width: 300, x: 10, y: 20 },
        session_id: "browser-1",
        source: "viewport",
      },
      toolContext
    );

    expect(mocks.requireWorkerScope).toHaveBeenCalledOnce();
    expect(mocks.requireOwnedBrowserSession).toHaveBeenCalledWith(
      scope,
      "browser-1"
    );
    expect(mocks.mask).toHaveBeenCalledOnce();
    expect(mocks.captureScreenshot).toHaveBeenCalledWith(
      "browser-1",
      { region: { height: 200, width: 300, x: 10, y: 20 } },
      { signal: toolContext.abortSignal }
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "viewport" })
    );
    expect(result).toEqual({ image });
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it.each([
    ["full_page", undefined, "fullPage: true"],
    ["element", "#landingImage", "#landingImage"],
  ] as const)(
    "captures a Playwright %s screenshot",
    async (source, selector, code) => {
      const input =
        source === "element"
          ? {
              label: "Product",
              selector,
              session_id: "browser-1",
              source,
            }
          : { label: "Product", session_id: "browser-1", source };
      await captureBrowserImage.execute(input, context());

      expect(JSON.stringify(mocks.playwrightExecute.mock.calls)).toContain(
        code
      );
      expect(mocks.readFile).toHaveBeenCalledOnce();
      expect(mocks.deleteFile).toHaveBeenCalledOnce();
    }
  );

  it("fetches an image element's original resource through the browser", async () => {
    const toolContext = context();
    mocks.playwrightExecute.mockResolvedValue({
      result: { url: "https://images.example/product.png?private=ignored" },
      success: true,
    });

    await captureBrowserImage.execute(
      {
        label: "Product",
        selector: "#landingImage",
        session_id: "browser-1",
        source: "image_resource",
      },
      toolContext
    );

    expect(mocks.retrieve).toHaveBeenCalledWith(
      "browser-1",
      {},
      { signal: toolContext.abortSignal }
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "browser-1",
      new URL("https://images.example/product.png?private=ignored"),
      expect.objectContaining({ method: "GET", timeout_ms: 20_000 })
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "image_resource" })
    );
    expect(JSON.stringify(mocks.persist.mock.calls)).not.toContain(
      "private=ignored"
    );
  });

  it("falls back to an element screenshot when the resource cannot be fetched", async () => {
    const toolContext = context();
    mocks.playwrightExecute
      .mockResolvedValueOnce({
        result: { url: "https://images.example/product.avif" },
        success: true,
      })
      .mockResolvedValueOnce({ result: true, success: true });
    mocks.fetch.mockResolvedValue(new Response("blocked", { status: 403 }));

    await captureBrowserImage.execute(
      {
        label: "Product",
        selector: "#landingImage",
        session_id: "browser-1",
        source: "image_resource",
      },
      toolContext
    );

    expect(mocks.readFile).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(
      scope,
      reservation,
      expect.objectContaining({ sourceKind: "element" })
    );
  });

  it("reuses a ready idempotent artifact without another capture", async () => {
    mocks.reserve.mockResolvedValue({ image, status: "ready" });

    const result = await captureBrowserImage.execute(
      {
        label: "Product",
        session_id: "browser-1",
        source: "viewport",
      },
      context()
    );

    expect(result).toEqual({ image });
    expect(mocks.captureScreenshot).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("leaves a shared pending reservation available when capture fails", async () => {
    mocks.captureScreenshot.mockRejectedValue(new Error("Kernel failed"));

    await expect(
      captureBrowserImage.execute(
        {
          label: "Product",
          session_id: "browser-1",
          source: "viewport",
        },
        context()
      )
    ).rejects.toThrow("Kernel failed");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("deletes a temporary screenshot without reusing an aborted signal", async () => {
    const controller = new AbortController();
    mocks.readFile.mockImplementation(() => {
      controller.abort();
      throw new Error("Capture cancelled");
    });

    await expect(
      captureBrowserImage.execute(
        {
          label: "Product",
          session_id: "browser-1",
          source: "full_page",
        },
        context(controller.signal)
      )
    ).rejects.toThrow("Capture cancelled");
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
    expect(mocks.deleteFile.mock.calls[0]).toHaveLength(2);
    expect(JSON.stringify(mocks.deleteFile.mock.calls[0]?.[1])).toContain(
      "/tmp/"
    );
  });
});

function context(abortSignal?: AbortSignal) {
  return toolContextFor({
    abortSignal: abortSignal ?? new AbortController().signal,
    callId: "call-image",
    parentSessionId: "root-session",
    sessionId: "worker-session",
    toolName: "capture_browser_image",
  });
}
