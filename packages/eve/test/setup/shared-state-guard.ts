import { afterAll, beforeAll } from "vitest";

/**
 * Guard for the shared-state unit project.
 *
 * Files in that project reuse a worker's environment and module graph, so
 * process-wide state left behind by one file changes what the next file sees.
 * Each file records the environment and the global `fetch` it starts from, and
 * fails when it ends different. A file that needs to change either belongs in
 * the isolated project, which the unit config decides from the file's source.
 */

let startingEnvironment: Map<string, string | undefined>;
let startingFetch: typeof globalThis.fetch;

beforeAll(() => {
  startingEnvironment = new Map(Object.entries(process.env));
  startingFetch = globalThis.fetch;
});

afterAll(() => {
  const changed: string[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (startingEnvironment.get(key) !== value) changed.push(`${key}=${value ?? ""}`);
  }

  for (const key of startingEnvironment.keys()) {
    if (!(key in process.env)) changed.push(`${key} (removed)`);
  }

  if (globalThis.fetch !== startingFetch) changed.push("globalThis.fetch (replaced)");

  if (changed.length > 0) {
    throw new Error(
      `This unit test file changed state its worker shares with the next file: ${changed.join(
        ", ",
      )}. Restore it before the file ends, or move the file to the isolated project.`,
    );
  }
});
