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

    expect(snapshots).toEqual([{ identity, pendingDeploy: false }]);
    expect(tracker.current()).toEqual({ identity, pendingDeploy: false });
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

    expect(snapshots).toEqual([{ pendingDeploy: false }]);
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

    expect(snapshots).toEqual([{ identity: { projectName: "newer" }, pendingDeploy: false }]);
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

    expect(snapshots).toEqual([{ identity, pendingDeploy: false }]);
    expect(tracker.current()).toEqual({ identity, pendingDeploy: false });
  });

  it("sets pending on channels-added and clears it on deployed", async () => {
    const { snapshots, onChange } = collect();
    let probes = 0;
    const tracker = createVercelStatusTracker({
      appRoot: "/app",
      onChange,
      detectIdentity: async () => {
        probes += 1;
        return identity;
      },
    });

    tracker.applyEffect({ kind: "channels-added" });
    expect(tracker.current().pendingDeploy).toBe(true);

    tracker.applyEffect({ kind: "deployed" });
    await settled();

    expect(tracker.current()).toEqual({ identity, pendingDeploy: false });
    // The deployed effect re-probes: the deploy flow can create the link.
    expect(probes).toBe(1);
    expect(snapshots.map((s) => s.pendingDeploy)).toEqual([true, false, false]);
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

    expect(snapshots).toEqual([{ identity, pendingDeploy: false }]);
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
    tracker.applyEffect({ kind: "channels-added" });

    expect(snapshots).toEqual([]);
  });
});
