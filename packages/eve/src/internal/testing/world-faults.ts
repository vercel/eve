import type { RuntimeWorld } from "#execution/world/runtime-world.js";

// A World that fails where a test says: it tells a test about each write an in-process session
// makes to it, as a stream line or as an entry of the session's log, and drops every write after
// the test says the process died, as if it had.

/** One write an in-process session makes to its World. */
export type WorldWrite =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "entry"; readonly entry: string; readonly value: unknown };

export interface WorldFaults {
  /** Before each write lands. Throwing, or killing the process, keeps it from landing. */
  readonly before?: (write: WorldWrite) => void | Promise<void>;
  /** Once each write landed. */
  readonly after?: (write: WorldWrite) => void | Promise<void>;
}

const decoder = new TextDecoder();

function entryOf(data: {
  readonly eventType: string;
  readonly eventData?: unknown;
}): WorldWrite | undefined {
  if (data.eventType !== "step_created") return undefined;
  const { input, stepName } = data.eventData as {
    readonly input: Uint8Array;
    readonly stepName: string;
  };
  // A journal record's value, out of the envelope the entity layer keeps it in.
  const envelope = JSON.parse(decoder.decode(input)) as { readonly v?: unknown };
  return { entry: stepName, kind: "entry", value: envelope.v };
}

/** `world`, telling `faults` about each write; writes stop landing once `dead()` is true. */
export function faultyWorld(
  world: RuntimeWorld,
  faults: WorldFaults & { readonly dead?: () => boolean },
): RuntimeWorld {
  const landing = async (write: WorldWrite | undefined, land: () => Promise<unknown>) => {
    if (faults.dead?.() === true) return undefined;
    if (write !== undefined) await faults.before?.(write);
    if (faults.dead?.() === true) return undefined;
    const landed = await land();
    if (write !== undefined) await faults.after?.(write);
    return landed;
  };
  return {
    ...world,
    // Read through: a World that loads lazily knows its capabilities only once it loaded.
    get capabilities() {
      return world.capabilities;
    },
    getDeploymentId: () => world.getDeploymentId(),
    events: {
      create: (runId, data, params) =>
        landing(entryOf(data), () => world.events.create(runId, data, params)),
      list: (params) => world.events.list(params),
    },
    runs: { list: (params) => world.runs.list(params) },
    streams: {
      ...world.streams,
      close: (runId, name) => world.streams.close(runId, name),
      getChunks: (runId, name, options) => world.streams.getChunks(runId, name, options),
      getInfo: (runId, name) => world.streams.getInfo(runId, name),
      async write(runId, name, chunk) {
        const line = typeof chunk === "string" ? chunk : decoder.decode(chunk);
        await landing({ kind: "line", line }, () => world.streams.write(runId, name, chunk));
      },
      // A batch lands line by line here, so a fault still lands or drops each line on its own.
      async writeMulti(runId, name, chunks) {
        for (const chunk of chunks) await this.write(runId, name, chunk);
      },
    },
  };
}

/**
 * `world` until a session writes a line `dies` matches: nothing written after that line lands,
 * as if the process had died there. `death` resolves once it did.
 */
export function dyingAfter(world: RuntimeWorld, dies: (line: string) => boolean) {
  let dead = false;
  let died: () => void = () => {};
  const death = new Promise<void>((resolve) => (died = resolve));
  return {
    death,
    world: faultyWorld(world, {
      after: (write) => {
        if (write.kind === "line" && dies(write.line)) {
          dead = true;
          died();
        }
      },
      dead: () => dead,
    }),
  };
}
