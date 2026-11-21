import { randomUUID } from "node:crypto";
import { bindings } from "./controller.js";
import { credential, hmacSecret, type Config } from "./config.js";
import { readAgentRuns } from "./agent-runs.js";
import { openIndependent, checkout } from "./hosted.js";
import { GitHub, Vercel } from "./providers.js";
import { store, storageBackend } from "./store.js";
import { verifyRelease } from "./verify.js";
import type { Check, Experiment } from "./types.js";

export async function checkReadiness(
  c: Config,
  options: { sandbox?: boolean; production?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const probe = async (name: string, run: () => Promise<string>) => {
    try {
      checks.push({ name, status: "passed", reason: await run() });
    } catch {
      checks.push({
        name,
        status: "failed",
        reason: `${name} failed; inspect the configured capability or private setup/provider logs. Credentials and provider bodies withheld.`,
      });
    }
  };
  await probe("private telemetry key", async () => {
    hmacSecret(c);
    return "HMAC key configured; identifiers and argument fingerprints are pseudonymized";
  });
  await probe("credentials", async () => {
    await credential(c, "github");
    await credential(c, "vercel");
    return "Both host-side credential providers resolved; secrets never returned";
  });
  await probe("repository/Vercel identity", async () => (await bindings(c)).reason);
  await probe("durable storage and retention deletion", async () => {
    const db = store(c),
      key = `doctor:${randomUUID()}`;
    await db.put(key, { probe: true }, -1);
    const before = await db.hasRecord(key);
    await db.purge();
    const after = await db.hasRecord(key);
    if (!before || after) throw new Error("Retention deletion not observed");
    return `${storageBackend(c)}: authenticated write/read and physical expiry deletion verified in this instance's namespace`;
  });
  await probe("Agent Runs metadata", async () => {
    const end = Math.floor(Date.now() / 1000) - 120;
    const evidence = await readAgentRuns(c, { from: end - 3600, to: end });
    if (!evidence.complete) throw new Error("Metadata incomplete");
    return `Complete fixed-window query; ${evidence.runs.length} real runs. No trace=1 request, titles or conversation text.`;
  });
  await probe("GitHub source access", async () => {
    const git = new GitHub(c),
      repo = await git.api(`/repos/${git.repo}`);
    await git.manifest(await git.main());
    if (repo.permissions?.push !== true) throw new Error("Write permission not observed");
    return "Repository read and reported push authority verified; an actual signed PR remains a separate execution check";
  });
  if (options.sandbox)
    await probe("Vercel-hosted checkout", async () => {
      const sandbox = await openIndependent(c);
      try {
        await checkout(c, sandbox, await new GitHub(c).main());
        return "Real Vercel Sandbox opened and checked out the immutable target with firewall-only authentication";
      } finally {
        await sandbox.delete();
      }
    });
  else
    checks.push({
      name: "Vercel-hosted checkout",
      status: "unavailable",
      reason:
        "Run doctor with sandbox:true to exercise real sandbox creation and repository checkout",
    });
  checks.push({
    name: "trusted release executor",
    status: c.release ? "pending" : "unavailable",
    reason: c.release
      ? "Configured outside candidate/build sandboxes; execution is pending a real verified release"
      : "Proposal mode works without deployment credentials. Shipping requires release.deploy backed by a trusted eve CLI release service.",
  });
  const db = store(c);
  try {
    const occurrence = await db.get<{
      settled: boolean;
      outcome: string;
      status: string;
      at: string;
    }>("occurrence:last");
    checks.push({
      name: "actual scheduled tool and stored result",
      status: occurrence?.settled && occurrence.outcome === "completed" ? "passed" : "pending",
      reason: occurrence?.settled
        ? `Scheduled cycle settled and its decision was persisted at ${occurrence.at}: ${occurrence.status}`
        : "Pending the next real scheduled session, cycle call/result and matching stored decision; cron HTTP 200 is insufficient",
    });
    const experiments = await db.list<Experiment>("experiment:", 100);
    checks.push({
      name: "signed PR execution",
      status: experiments.some((e) => e.candidate && e.verifiedHead === e.candidate.head)
        ? "passed"
        : "pending",
      reason:
        "Requires a real candidate with a verified signed head and independent clean-sandbox checks; permission reads alone do not prove publishing",
    });
    checks.push({
      name: "rollback execution",
      status: experiments.some((e) =>
        e.release?.rollback?.checks.every((check) => check.status === "passed"),
      )
        ? "passed"
        : "pending",
      reason:
        "Supported rollback is implemented; no claim of observed recovery until a controlled rehearsal or real rollback is recorded",
    });
  } catch {
    checks.push({
      name: "execution history",
      status: "unavailable",
      reason: "Durable execution history could not be read",
    });
  }
  if (options.production) {
    try {
      const deployment = await new Vercel(c).deployment(c.project.productionUrl);
      checks.push(...(await verifyRelease(c, deployment)).checks);
    } catch {
      checks.push({
        name: "production verification",
        status: "failed",
        reason:
          "Exact production identity/authenticated execution/runtime or publisher verification failed; private details withheld",
      });
    }
  } else
    checks.push({
      name: "production verification",
      status: "unavailable",
      reason:
        "Run doctor with production:true after configuring authenticated smoke, runtime and publisher checks",
    });
  checks.push({
    name: "schedule configuration",
    status: "passed",
    reason: `${c.cron} UTC. This is scheduled monitoring. Personal schedules are not modified.`,
  });
  return checks;
}
