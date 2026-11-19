export * from "#compiled/@workflow/core/index.js";

export async function fetch(...args: Parameters<typeof globalThis.fetch>): Promise<Response> {
  "use step";
  return await globalThis.fetch(...args);
}
