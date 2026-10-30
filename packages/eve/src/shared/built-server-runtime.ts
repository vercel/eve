import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rejects Bun build output in Node before spawning it.
 *
 * `eve build` in Bun emits Nitro's Bun server, which needs the `Bun` global and
 * otherwise crashes with an error that does not name the runtime mismatch.
 */
export function assertBuiltServerRuntime(appRoot: string): void {
  if (process.versions.bun !== undefined) return;
  const outputDirectory = join(appRoot, ".output");
  let preset: unknown;
  try {
    preset = (
      JSON.parse(readFileSync(join(outputDirectory, "nitro.json"), "utf8")) as {
        preset?: unknown;
      }
    ).preset;
  } catch {
    return;
  }
  if (preset === "bun") {
    throw new Error(
      `The eve build output at ${outputDirectory} was built with Bun, so it must run in Bun. Start it with "bunx eve start", or rebuild it with Node ("npx eve build") to run it in Node.`,
    );
  }
}
