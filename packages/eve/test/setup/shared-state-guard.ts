import { afterAll, beforeAll, vi } from "vitest";

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
