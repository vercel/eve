import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorRelease, type MonitorServices } from "../../extension/lib/monitor.js";
import { ProviderError, Vercel } from "../../extension/lib/providers.js";
import { receiptValid } from "../../extension/lib/verify.js";
import { config, experiment, BASE, MERGED, requestFixture } from "./fixtures.js";
import type { Check, Deployment, Experiment } from "../../extension/lib/types.js";

const pass: Check = {
  name: "fresh authenticated tool",
  status: "passed",
  reason: "Observed deterministic tool execution",
};
const failed: Check = { ...pass, status: "failed", reason: "Tool execution failed" };
const baseline: Deployment = {
  id: "dpl_baseline",
  url: "https://baseline.example.com",
  sha: BASE,
  teamId: "team_fixture",
  projectId: "prj_fixture",
  environment: "production",
  ready: true,
};
const deployed: Deployment = {
  ...baseline,
  id: "dpl_released",
  url: "https://released.example.com",
  sha: MERGED,
};
const released = (): Experiment => ({
  ...experiment(),
  status: "monitoring",
  release: { sha: MERGED, baseline, baselineChecks: [pass], deployment: deployed },
});
function fixture() {
  const records = new Map<string, any>(),
    calls: string[] = [];
  let current = deployed;
  const services: MonitorServices = {
    journal: {
      async get<T>(key: string) {
        return (records.get(key) as T) ?? null;
      },
      async put(key, value) {
        records.set(key, value);
        calls.push(`put:${key}`);
      },
    },
    platform: {
      async deployment() {
        calls.push(`current:${current.id}`);
        return current;
      },
      async rollback(target) {
        assert.ok(records.get("rollback:fixture"));
        calls.push(`rollback:${target.id}`);
        current = baseline;
      },
    },
    async verify(deployment) {
      calls.push(`verify:${deployment.id}`);
      return { checks: [pass] };
    },
  };
  return {
    records,
    calls,
    services,
    setCurrent(value: Deployment) {
      current = value;
    },
  };
}
test("successful monitored releases retain verified production evidence", async () => {
  const f = fixture(),
    e = await monitorRelease(config(), released(), f.services);
  assert.equal(e.status, "shipped");
  assert.ok(e.release!.verifiedAt);
  assert.equal(f.records.size, 0);
  assert.ok(!f.calls.some((c) => c.startsWith("rollback:")));
});
test("provider outage, missing proof and unconfirmed bot delivery do not trigger rollback", async () => {
  for (const check of [
    { ...pass, name: "release delivery", status: "unavailable" as const },
    failed,
  ]) {
    const f = fixture();
    f.services.verify = async () => ({ checks: [check] });
    const e = await monitorRelease(config(), released(), f.services);
    assert.equal(e.status, "blocked");
    assert.equal(f.records.size, 0);
    assert.ok(!f.calls.some((c) => c.startsWith("rollback:")));
  }
});
test("causal runtime regression persists rollback intent before restoring and verifying baseline", async () => {
  const f = fixture();
  f.services.verify = async (deployment, options) => {
    if (deployment.id === deployed.id)
      return {
        checks: [failed],
        runtime: {
          deploymentId: deployed.id,
          status: "failed",
          reason: "Observed release regression",
          causedByRelease: true,
        },
      };
    assert.equal(options!.deliveryId, `rollback:${deployed.id}:${baseline.id}`);
    return { checks: [pass] };
  };
  const e = await monitorRelease(config(), released(), f.services);
  assert.equal(e.status, "rolled-back");
  assert.equal(e.release!.rollback!.deployment.id, baseline.id);
  assert.ok(f.calls.indexOf("put:rollback:fixture") < f.calls.indexOf(`rollback:${baseline.id}`));
});
test("repeated new tool failure with a working immutable baseline establishes causality", async () => {
  const f = fixture();
  let repeated = 0,
    immutable = false;
  f.services.verify = async (deployment, options) => {
    if (deployment.id === deployed.id) {
      repeated++;
      return { checks: [failed] };
    }
    immutable ||= options?.immutable === true;
    return { checks: [pass] };
  };
  assert.equal((await monitorRelease(config(), released(), f.services)).status, "rolled-back");
  assert.equal(repeated, 2);
  assert.equal(immutable, true);
});
test("lost rollback response resumes from persisted intent without repeating a completed rollback", async () => {
  const f = fixture();
  f.records.set("rollback:fixture", {
    from: deployed.id,
    to: baseline.id,
    sha: BASE,
    confirmedRegression: true,
  });
  f.setCurrent(baseline);
  assert.equal((await monitorRelease(config(), released(), f.services)).status, "rolled-back");
  assert.ok(!f.calls.some((c) => c.startsWith("rollback:")));
  f.records.get("rollback:fixture").to = "dpl_other";
  await assert.rejects(monitorRelease(config(), released(), f.services), /intent does not match/);
});
test("rollback authorization failure preserves exact safe blocker and recovery intent", async () => {
  const f = fixture();
  f.records.set("rollback:fixture", {
    from: deployed.id,
    to: baseline.id,
    sha: BASE,
    confirmedRegression: true,
  });
  f.services.platform.rollback = async () => {
    throw new ProviderError("Vercel", 403);
  };
  const e = await monitorRelease(config(), released(), f.services);
  assert.equal(e.status, "blocked");
  assert.match(e.reason!, /^URGENT:.*Vercel HTTP 403/);
  assert.ok(f.records.has("rollback:fixture"));
});
test("another production release is never overwritten during rollback recovery", async () => {
  const f = fixture();
  f.records.set("rollback:fixture", {
    from: deployed.id,
    to: baseline.id,
    sha: BASE,
    confirmedRegression: true,
  });
  f.setCurrent({ ...deployed, id: "dpl_other" });
  const e = await monitorRelease(config(), released(), f.services);
  assert.equal(e.status, "blocked");
  assert.match(e.reason!, /another deployment/);
  assert.ok(!f.calls.some((c) => c.startsWith("rollback:")));
});
test("rollback uses the supported Vercel v9 operation with a body and team scope", async () => {
  const platform = new Vercel(
    config(),
    requestFixture((url, init) => {
      assert.equal(url.pathname, "/v9/projects/prj_fixture/rollback/dpl_baseline");
      assert.equal(url.searchParams.get("teamId"), "team_fixture");
      assert.equal(init!.method, "POST");
      assert.equal(init!.body, "{}");
      return Response.json({});
    }),
  );
  await platform.rollback(baseline);
});
test("a prior receipt cannot satisfy another release or rollback verification", () => {
  const receipt = {
    status: "already-sent" as const,
    id: "release:old",
    url: "https://chat.example.com/message/1",
  };
  assert.equal(receiptValid(receipt, "release:new"), false);
  assert.equal(receiptValid(receipt, "release:old"), true);
});
