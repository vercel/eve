import { afterAll, beforeAll, vi } from "vitest";

/**
 * Guard for a shared-state test project.
 *
 * Files in that project reuse a worker's environment and module graph, so
 * process-wide state left behind by one file changes what the next file sees.
 * Each file records the environment, the global `fetch`, and OpenTelemetry's
 * global registrations it starts from, and fails when it ends different, or
 * when it ends with fake timers installed. A file that needs to change any of
 * them belongs in the isolated project, which the tier's config decides from
 * the file's source.
 */

// OpenTelemetry's global registry: a registration left behind refuses the next file's.
const OTEL_API = Symbol.for("opentelemetry.js.api.1");

interface Snapshot {
  readonly environment: Map<string, string | undefined>;
  readonly fetch: typeof globalThis.fetch;
  readonly otel: ReadonlyMap<string, unknown>;
}

let startingState: Snapshot;

beforeAll(() => {
  startingState = snapshot();
});

afterAll(() => {
  const endingState = snapshot();
  const changed: string[] = [];

  for (const [key, value] of endingState.environment) {
    if (startingState.environment.get(key) !== value) changed.push(`${key}=${value ?? ""}`);
  }

  for (const key of startingState.environment.keys()) {
    if (!endingState.environment.has(key)) changed.push(`${key} (removed)`);
  }

  if (endingState.fetch !== startingState.fetch) changed.push("globalThis.fetch (replaced)");

  // The API keeps its `version` once anything registered; the registrations are the rest.
  for (const name of endingState.otel.keys()) {
    if (startingState.otel.get(name) !== endingState.otel.get(name)) {
      changed.push(`the global OpenTelemetry ${name}`);
    }
  }

  for (const name of startingState.otel.keys()) {
    if (!endingState.otel.has(name)) changed.push(`the global OpenTelemetry ${name} (removed)`);
  }

  if (vi.isFakeTimers()) changed.push("fake timers");

  if (changed.length > 0) {
    throw new Error(
      `This test file changed state its worker shares with the next file: ${changed.join(
        ", ",
      )}. Restore it before the file ends, or move the file to the isolated project.`,
    );
  }
});

function snapshot(): Snapshot {
  const otel = (globalThis as { [OTEL_API]?: Record<string, unknown> })[OTEL_API] ?? {};
  return {
    environment: new Map(Object.entries(process.env)),
    fetch: globalThis.fetch,
    otel: new Map(Object.entries(otel).filter(([name]) => name !== "version")),
  };
}
