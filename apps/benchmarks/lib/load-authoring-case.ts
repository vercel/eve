import { createJiti } from "jiti";

import type { AuthoringCase } from "./authoring-case.js";

export async function loadAuthoringCase(fixturePath: string): Promise<AuthoringCase> {
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  let loaded: unknown = await jiti.import(`${fixturePath}/CASE.ts`);
  while (!isAuthoringCase(loaded) && hasDefaultExport(loaded)) loaded = loaded.default;
  if (!isAuthoringCase(loaded)) {
    throw new Error(`${fixturePath}/CASE.ts must export an authoring case as default.`);
  }
  return loaded;
}

function isAuthoringCase(value: unknown): value is AuthoringCase {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthoringCase>;
  return candidate.startingPoint !== undefined && typeof candidate.interact === "function";
}

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return typeof value === "object" && value !== null && "default" in value;
}
