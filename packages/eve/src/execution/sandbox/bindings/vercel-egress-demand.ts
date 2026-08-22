import type { Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";

export const VERCEL_EGRESS_DEMAND_DIRECTORY = "/tmp/eve-egress-demand";

export function getVercelEgressDemandMarkerPath(ruleId: string): string {
  if (!/^r\d+-\d+$/.test(ruleId)) {
    throw new Error(`Invalid sandbox egress rule id "${ruleId}".`);
  }
  return `${VERCEL_EGRESS_DEMAND_DIRECTORY}/${ruleId}`;
}

export async function readVercelEgressDemandedRuleIds(
  sandbox: SdkSandbox,
  ruleIds: readonly string[],
): Promise<string[]> {
  const demanded = await Promise.all(
    ruleIds.map(async (ruleId) => {
      const marker = await sandbox.readFile({ path: getVercelEgressDemandMarkerPath(ruleId) });
      return marker === null ? undefined : ruleId;
    }),
  );
  return demanded.filter((ruleId): ruleId is string => ruleId !== undefined);
}

export async function clearVercelEgressDemandMarkers(
  sandbox: SdkSandbox,
  ruleIds: readonly string[],
): Promise<void> {
  await Promise.all(
    ruleIds.map(async (ruleId) => {
      await sandbox.fs.rm(getVercelEgressDemandMarkerPath(ruleId), { force: true });
    }),
  );
}
