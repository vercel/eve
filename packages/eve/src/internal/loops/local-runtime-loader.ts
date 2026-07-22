import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type InlineRuntimeModule = typeof import("#internal/loops/inline/runtime.js");
type TemporalRuntimeModule = typeof import("#internal/loops/temporal/runtime.js");

/** Loads the process-local implementation without adding it to a Vercel Function bundle. */
export async function loadInlineRuntimeModule(): Promise<InlineRuntimeModule> {
  return await import(resolveRuntimeUrl("inline"));
}

/** Loads the local Temporal implementation without adding it to a Vercel Function bundle. */
export async function loadTemporalRuntimeModule(): Promise<TemporalRuntimeModule> {
  return await import(resolveRuntimeUrl("temporal"));
}

function resolveRuntimeUrl(kind: "inline" | "temporal"): string {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("eve/package.json"));
  return pathToFileURL(join(packageRoot, `dist/src/internal/loops/${kind}/runtime.js`)).href;
}
