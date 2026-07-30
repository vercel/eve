import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNodeDevelopmentRunner } from "#internal/nitro/host/dev-runner.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("Node development runner shutdown", () => {
  it("awaits worker-owned close hooks exactly once", async () => {
    const scratchRoot = await createScratchDirectory("eve-dev-runner-close-");
    const eventsPath = join(scratchRoot, "events.log");
    const entryPath = join(scratchRoot, "entry.mjs");

    await writeFile(
      entryPath,
      [
        'import { appendFile } from "node:fs/promises";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        "export default {",
        '  fetch() { return new Response("ok"); },',
        "  ipc: {",
        "    async onClose() {",
        '      await appendFile(eventsPath, "close:start\\n");',
        "      await new Promise((resolve) => setTimeout(resolve, 25));",
        '      await appendFile(eventsPath, "close:end\\n");',
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const runner = createNodeDevelopmentRunner({
      entry: entryPath,
      name: "close-probe",
      workerData: {},
    });
    await runner.waitForReady(5_000);

    await runner.close();
    await runner.close();

    await expect(readFile(eventsPath, "utf8")).resolves.toBe("close:start\nclose:end\n");
  });

  it("force-reaps a worker whose close hook never settles", async () => {
    const scratchRoot = await createScratchDirectory("eve-dev-runner-stuck-close-");
    const eventsPath = join(scratchRoot, "events.log");
    const entryPath = join(scratchRoot, "entry.mjs");

    await writeFile(
      entryPath,
      [
        'import { appendFile } from "node:fs/promises";',
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        "export default {",
        '  fetch() { return new Response("ok"); },',
        "  ipc: {",
        "    async onClose() {",
        '      await appendFile(eventsPath, "close\\n");',
        "      await new Promise(() => undefined);",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const runner = createNodeDevelopmentRunner({
      entry: entryPath,
      name: "stuck-close-probe",
      workerData: {},
    });
    await runner.waitForReady(5_000);

    const startedAt = Date.now();
    await runner.close();
    await runner.close();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(readFile(eventsPath, "utf8")).resolves.toBe("close\n");
  });
});
