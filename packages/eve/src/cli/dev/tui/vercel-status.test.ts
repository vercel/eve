import { describe, expect, it } from "vitest";

import { createVercelStatusTracker, type VercelStatusSnapshot } from "./vercel-status.js";

const identity = { projectName: "my-agent", teamName: "acme" };

function collect(): {
  snapshots: VercelStatusSnapshot[];
  onChange: (s: VercelStatusSnapshot) => void;
} {
  const snapshots: VercelStatusSnapshot[] = [];
  return { snapshots, onChange: (snapshot) => snapshots.push(snapshot) };
}

async function settled(): Promise<void> {
  // Two microtask hops: one for the probe's await, one for the emit.
  await Promise.resolve();
  await Promise.resolve();
}

describe("createVercelStatusTracker", () => {
  it("emits the resolved identity after a refresh", async () => {
    const { snapshots, onChange } = collect();
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: async () => identity,
    });

    tracker.refreshIdentity();
    await settled();

    expect(snapshots).toEqual([{ identity }]);
    expect(tracker.current()).toEqual({ identity });
  });

  it("emits a snapshot without identity for an unlinked directory", async () => {
    const { snapshots, onChange } = collect();
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: async () => undefined,
    });

    tracker.refreshIdentity();
    await settled();

    expect(snapshots).toEqual([{}]);
    expect(tracker.current().identity).toBeUndefined();
  });

  it("discards a stale probe that loses the race to a newer refresh", async () => {
    const { snapshots, onChange } = collect();
    let resolveSlow: (value: typeof identity) => void;
    const slow = new Promise<typeof identity>((resolve) => {
      resolveSlow = resolve;
    });
    let probe = 0;
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: () => {
        probe += 1;
        return probe === 1 ? slow : Promise.resolve({ projectName: "newer" });
      },
    });

    tracker.refreshIdentity();
    tracker.refreshIdentity();
    await settled();
    resolveSlow!({ projectName: "stale", teamName: "stale-team" });
    await settled();

    expect(snapshots).toEqual([{ identity: { projectName: "newer" } }]);
  });

  it("keeps the last identity when a probe throws", async () => {
    const { snapshots, onChange } = collect();
    let probe = 0;
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: () => {
        probe += 1;
        return probe === 1 ? Promise.resolve(identity) : Promise.reject(new Error("boom"));
      },
    });

    tracker.refreshIdentity();
    await settled();
    tracker.refreshIdentity();
    await settled();

    expect(snapshots).toEqual([{ identity }]);
    expect(tracker.current()).toEqual({ identity });
  });

  it("re-probes on refresh-identity without emitting until the probe lands", async () => {
    const { snapshots, onChange } = collect();
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: async () => identity,
    });

    tracker.applyEffect({ kind: "refresh-identity" });
    expect(snapshots).toEqual([]);
    await settled();

    expect(snapshots).toEqual([{ identity }]);
  });

  it("suppresses emissions after dispose, including in-flight probes", async () => {
    const { snapshots, onChange } = collect();
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: async () => identity,
    });

    tracker.refreshIdentity();
    tracker.dispose();
    await settled();
    tracker.applyEffect({ kind: "refresh-identity" });

    expect(snapshots).toEqual([]);
  });

  it("aborts an in-flight identity probe when disposed", () => {
    let probeSignal: AbortSignal | undefined;
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange: () => {},
      detectIdentity: (_appRoot, options) => {
        probeSignal = options?.signal;
        return new Promise<undefined>(() => {});
      },
    });

    tracker.refreshIdentity();

    expect(probeSignal).toBeDefined();
    tracker.dispose();
    expect(probeSignal?.aborted).toBe(true);
  });
});
