/**
 * Authored sources and event readers shared by the dev-server generation
 * scenarios, which split across files so each file's server runs in its own
 * worker.
 */

/**
 * A tool that returns `marker`. With `crashOnce`, its first call writes
 * `.turn-started`, waits for `.crash-turn-worker`, and exits its worker once.
 */
export function createGenerationMarkerToolSource(marker: string, crashOnce: boolean): string {
  const lifecycle = crashOnce
    ? [
        'import { existsSync, watch, writeFileSync } from "node:fs";',
        'import { basename, join } from "node:path";',
        "",
        "async function waitForPath(path: string) {",
        "  if (existsSync(path)) return;",
        "  await new Promise<void>((resolve) => {",
        "    const watcher = watch(process.cwd(), (_event, filename) => {",
        "      if (filename !== basename(path)) return;",
        "      watcher.close();",
        "      resolve();",
        "    });",
        "    if (existsSync(path)) {",
        "      watcher.close();",
        "      resolve();",
        "    }",
        "  });",
        "}",
        "",
      ]
    : [];
  const execute = crashOnce
    ? [
        '    const startedPath = join(process.cwd(), ".turn-started");',
        '    const crashPath = join(process.cwd(), ".crash-turn-worker");',
        '    const crashedPath = join(process.cwd(), ".turn-worker-crashed");',
        '    writeFileSync(startedPath, "ready");',
        "    await waitForPath(crashPath);",
        "    if (!existsSync(crashedPath)) {",
        '      writeFileSync(crashedPath, "crashed");',
        "      process.exit(1);",
        "    }",
      ]
    : [];

  return [
    ...lifecycle,
    'import { defineTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "export default defineTool({",
    '  description: "Return the selected development generation marker.",',
    "  inputSchema: z.object({ city: z.string().optional() }),",
    "  async execute() {",
    ...execute,
    `    return { instrumentation: "instrumentation-" + String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"), marker: ${JSON.stringify(marker)} };`,
    "  },",
    "});",
    "",
  ].join("\n");
}

/** The text of every completed content event, one per line. */
export function readCompletedMessages(
  events: readonly { readonly data?: unknown; readonly type: string }[],
): string {
  return events
    .flatMap((event) => {
      if (event.type !== "content.completed" || !isRecord(event.data)) {
        return [];
      }
      return typeof event.data.value === "string" ? [event.data.value] : [];
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
