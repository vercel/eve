import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createNodeDevelopmentRunner } from "#internal/nitro/host/dev-runner.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("Node development runner", () => {
  it("runs the worker IPC close hook during graceful shutdown", async () => {
    const root = await createScratchDirectory("eve-dev-runner-shutdown-");
    const entryPath = join(root, "worker.mjs");
    const markerPath = join(root, "closed.txt");
    await writeFile(
      entryPath,
      [
        'import { writeFile } from "node:fs/promises";',
        "",
        "export default {",
        '  fetch: () => new Response("worker-ready"),',
        "  ipc: {",
        "    async onClose() {",
        `      await writeFile(${JSON.stringify(markerPath)}, "gracefully-closed\\n", "utf8");`,
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const runner = createNodeDevelopmentRunner({
      entry: entryPath,
      name: "eve-dev-runner-shutdown-test",
      workerData: {},
    });
    let closeDurationMs = Number.POSITIVE_INFINITY;

    try {
      await runner.waitForReady(5_000);
      const response = await runner.fetch(new Request("http://eve.test/"));
      await expect(response.text()).resolves.toBe("worker-ready");
    } finally {
      const closeStartedAt = performance.now();
      await runner.close();
      closeDurationMs = performance.now() - closeStartedAt;
    }

    expect(closeDurationMs).toBeLessThan(5_000);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("gracefully-closed\n");
    const lateCloseListener = vi.fn();
    runner.onceClosed(lateCloseListener);
    expect(lateCloseListener).toHaveBeenCalledWith(undefined);
  });
});
