import { describe, expect, it, vi } from "vitest";
import { withVaultScreenshotMask } from "../vault-screenshot-mask";

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        sessionId: string,
        body: { readonly code: string; readonly timeout_sec: number },
        options: { readonly signal?: AbortSignal }
      ) => Promise<{ readonly success: boolean }>
    >(),
}));

vi.mock("@agent/subagents/browser-agent/lib/kernel", () => ({
  kernel: { browsers: { playwright: { execute: mocks.execute } } },
}));

describe("Vault screenshot masking", () => {
  it("removes the mask with a fresh request after capture cancellation", async () => {
    const controller = new AbortController();
    mocks.execute.mockResolvedValue({ success: true });

    await expect(
      withVaultScreenshotMask("browser-1", controller.signal, async () => {
        controller.abort();
        throw new Error("Capture cancelled");
      })
    ).rejects.toThrow("Capture cancelled");

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.execute.mock.calls[0]?.[1])).toContain(
      "append(style)"
    );
    expect(mocks.execute.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
    });
    expect(JSON.stringify(mocks.execute.mock.calls[1]?.[1])).toContain(
      "remove()"
    );
    expect(mocks.execute.mock.calls[1]?.[2]).toEqual({
      signal: undefined,
    });
  });

  it("keeps the shared mask until every overlapping capture completes", async () => {
    let maskReferences = 0;
    mocks.execute.mockImplementation(
      async (_sessionId: string, body: { code: string }) => {
        maskReferences += body.code.includes("remainingRefs") ? -1 : 1;
        return { success: true };
      }
    );
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    const first = withVaultScreenshotMask(
      "browser-1",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    );
    await vi.waitFor(() => {
      expect(maskReferences).toBe(1);
    });
    const second = withVaultScreenshotMask(
      "browser-1",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        })
    );
    await vi.waitFor(() => {
      expect(maskReferences).toBe(2);
    });

    finishFirst?.();
    await first;
    expect(maskReferences).toBe(1);

    finishSecond?.();
    await second;
    expect(maskReferences).toBe(0);
    expect(JSON.stringify(mocks.execute.mock.calls)).toContain("vaultMaskRefs");
  });
});
