export * from "#compiled/@workflow/core/index.js";

/**
 * Workflow-safe fetch helper retained for generated or authored workflow code
 * that imports `fetch` from the historical `workflow` package surface.
 */
export async function fetch(...args: Parameters<typeof globalThis.fetch>): Promise<Response> {
  "use step";
  return await globalThis.fetch(...args);
}
