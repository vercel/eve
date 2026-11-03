import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEV_SERVER_CLOSE_BUDGET_MS } from "#cli/dev/local-server-process.js";
import { createNodeDevelopmentRunner } from "#internal/nitro/host/dev-runner.js";
import { DrainedNitroDevServer } from "#internal/nitro/host/drained-nitro-dev-server.js";
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

  it("closes the dev server within the CLI's budget while a response is still streaming", async () => {
    const root = await createScratchDirectory("eve-dev-runner-open-stream-");
    const entryPath = join(root, "worker.mjs");
    await writeFile(
      entryPath,
      [
        "export default {",
        "  fetch: () =>",
        "    new Response(",
        "      new ReadableStream({",
        '        start(controller) { controller.enqueue(new TextEncoder().encode("first")); },',
        "      }),",
        "    ),",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const server = new DrainedNitroDevServer({ error: () => undefined });
    const listener = server.listen({ hostname: "127.0.0.1", port: 0 });
    await listener.ready();
    await server.replaceWorker({ entry: entryPath, workerData: {} });

    const response = await fetch(new URL("/stream", listener.url));
    const reader = response.body!.getReader();
    await reader.read();

    const closeStartedAt = performance.now();
    await server.close();
    expect(performance.now() - closeStartedAt).toBeLessThan(DEV_SERVER_CLOSE_BUDGET_MS);
    await reader.cancel().catch(() => undefined);
  });
});
