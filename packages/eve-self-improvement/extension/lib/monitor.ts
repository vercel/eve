import type { Config } from "./config.js";
import { allPassed } from "./gates.js";
import { Vercel, ProviderError } from "./providers.js";
import { store, type Storage } from "./store.js";
import { verifyRelease } from "./verify.js";
import type { Deployment, Experiment } from "./types.js";
import { setTimeout as delay } from "node:timers/promises";

type Verify = (
  deployment: Deployment,
  options?: Parameters<typeof verifyRelease>[2],
) => ReturnType<typeof verifyRelease>;
export interface MonitorServices {
  platform: Pick<Vercel, "deployment" | "rollback">;
  journal: Pick<Storage, "get" | "put">;
  verify: Verify;
}
interface RollbackIntent {
  from: string;
  to: string;
  sha: string;
  confirmedRegression: true;
}

export async function monitorRelease(
  c: Config,
  experiment: Experiment,
  services?: MonitorServices,
): Promise<Experiment> {
  if (!experiment.release?.deployment) throw new Error("Release state lacks a deployment");
  const { platform, journal, verify } = services ?? {
    platform: new Vercel(c),
    journal: store(c),
    verify: (deployment, options) => verifyRelease(c, deployment, options),
  };
  const release = experiment.release,
    deployed = release.deployment!;
  const rollbackIntent = await journal.get<RollbackIntent>(`rollback:${experiment.id}`);
  if (
    rollbackIntent &&
    (rollbackIntent.from !== deployed.id ||
      rollbackIntent.to !== release.baseline.id ||
      rollbackIntent.sha !== release.baseline.sha ||
      rollbackIntent.confirmedRegression !== true)
  )
    throw new Error("Rollback intent does not match the recorded release/baseline");
  const superseded = () => {
    experiment.status = "superseded";
    experiment.reason =
      "Production now serves another deployment; monitoring of this release is complete";
    return experiment;
  };
  let result: Awaited<ReturnType<Verify>> | undefined;
  if (!rollbackIntent) {
    try {
      if ((await platform.deployment(c.project.productionUrl)).id !== deployed.id)
        return superseded();
      result = await verify(deployed, { baseline: release.baseline, delivery: true });
    } catch {
      const current = await platform.deployment(c.project.productionUrl).catch(() => null);
      if (current && current.id !== deployed.id) return superseded();
      experiment.status = "blocked";
      experiment.reason =
        "Production identity/verification unavailable; preserve baseline and reconcile before another release";
      return experiment;
    }
    release.checks = result.checks;
    if (allPassed(result.checks)) {
      release.verifiedAt = Date.now();
      experiment.status = "shipped";
      experiment.reason =
        "Exact production identity, fresh authenticated execution, runtime and publisher verification passed";
      return experiment;
    }
  }

  let causedByRelease =
    !!rollbackIntent ||
    (result?.runtime?.deploymentId === deployed.id &&
      result.runtime.status === "failed" &&
      result.runtime.causedByRelease === true);
  if (
    !causedByRelease &&
    result?.checks.some(
      (check) => check.name === "fresh authenticated tool" && check.status === "failed",
    )
  ) {
    const [old, repeated] = await Promise.all([
      verify(release.baseline, { immutable: true }).catch(() => null),
      verify(deployed, { baseline: release.baseline }).catch(() => null),
    ]);
    causedByRelease =
      !!old &&
      allPassed(old.checks) &&
      !!repeated &&
      repeated.checks.some(
        (check) => check.name === "fresh authenticated tool" && check.status === "failed",
      );
  }
  if (!causedByRelease) {
    experiment.status = "blocked";
    experiment.reason =
      "Release verification failed; causal evidence is insufficient for rollback. Preserve state and investigate provider/runtime diagnostics.";
    return experiment;
  }
  let blocker = "recovery verification unavailable";
  try {
    await journal.put(`rollback:${experiment.id}`, {
      from: deployed.id,
      to: release.baseline.id,
      sha: release.baseline.sha,
      confirmedRegression: true,
    });
    const current = await platform.deployment(c.project.productionUrl);
    if (current.id !== release.baseline.id) {
      blocker = "production is now owned by another deployment; refusing to overwrite it";
      if (current.id !== deployed.id) throw new Error("Concurrent production change");
      blocker = "platform rollback operation failed or its outcome is unconfirmed";
      await platform.rollback(release.baseline);
    }
    blocker = "production alias has not restored the recorded deployment";
    let recovered = await platform.deployment(c.project.productionUrl);
    for (let attempt = 0; recovered.id === deployed.id && attempt < 10; attempt++) {
      await delay(3000);
      recovered = await platform.deployment(c.project.productionUrl);
    }
    if (recovered.id !== release.baseline.id) throw new Error("Rollback identity mismatch");
    blocker = "restored deployment failed authenticated/runtime/publisher/delivery verification";
    const verification = await verify(recovered, {
      delivery: true,
      deliveryId: `rollback:${deployed.id}:${recovered.id}`,
    });
    release.rollback = { deployment: recovered, checks: verification.checks };
    if (!allPassed(verification.checks)) throw new Error("Recovery checks failed");
    experiment.status = "rolled-back";
    experiment.reason =
      "Confirmed release regression; restored and verified the recorded known-good deployment. Revert PR required.";
  } catch (error) {
    if (error instanceof ProviderError)
      blocker = `${error.provider} HTTP ${error.status} during rollback/recovery`;
    experiment.status = "blocked";
    experiment.reason = `URGENT: confirmed release regression; ${blocker}. Preserve rollback intent, inspect private diagnostics and stop further releases.`;
  }
  return experiment;
}
