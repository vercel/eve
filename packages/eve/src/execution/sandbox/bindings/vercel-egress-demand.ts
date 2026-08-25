import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";

export const VERCEL_EGRESS_DEMAND_DIRECTORY = "/tmp/eve-egress-demand";

const DEMAND_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const RULE_ID_PATTERN = /^r-[0-9a-f]{12}-\d+$/;

/**
 * Derives the stable identity of a managed egress rule from its domain and
 * its index within that domain's rule list. Consent grants, resolved tokens,
 * and demand markers are all keyed by this id, so it must not depend on the
 * ordering of domains in the authored policy: reordering the policy must
 * never re-attribute a grant minted for one domain to another.
 */
export function vercelEgressRuleId(domain: string, index: number): string {
  const domainHash = createHash("sha256").update(domain).digest("hex").slice(0, 12);
  return `r-${domainHash}-${String(index)}`;
}

export function isVercelEgressRuleId(value: string): boolean {
  return RULE_ID_PATTERN.test(value);
}

/**
 * Mints the proxy-attested demand token for one sandbox policy build.
 *
 * The token travels only host → firewall `forwardURL` → egress proxy; the
 * sandbox sees the marker file the proxy writes but never a valid token
 * value, so marker contents forged from inside the sandbox fail
 * verification and demand is only honored when an authenticated request
 * actually reached the proxy.
 */
export function mintVercelEgressDemandToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isVercelEgressDemandToken(value: string): boolean {
  return DEMAND_TOKEN_PATTERN.test(value);
}

export function getVercelEgressDemandMarkerPath(ruleId: string): string {
  if (!isVercelEgressRuleId(ruleId)) {
    throw new Error(`Invalid sandbox egress rule id "${ruleId}".`);
  }
  return `${VERCEL_EGRESS_DEMAND_DIRECTORY}/${ruleId}`;
}

export async function readVercelEgressDemandedRuleIds(
  sandbox: SdkSandbox,
  ruleIds: readonly string[],
  expectedToken: string | undefined,
): Promise<string[]> {
  if (expectedToken === undefined || !isVercelEgressDemandToken(expectedToken)) {
    return [];
  }
  const demanded = await Promise.all(
    ruleIds.map(async (ruleId) => {
      const marker = normalizeVercelReadStream(
        await sandbox.readFile({ path: getVercelEgressDemandMarkerPath(ruleId) }),
      );
      if (marker === null) return undefined;
      const content = (await streamToBuffer(marker)).toString("utf8").trim();
      return demandTokenMatches(content, expectedToken) ? ruleId : undefined;
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

function demandTokenMatches(content: string, expected: string): boolean {
  const contentBytes = Buffer.from(content, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    contentBytes.length === expectedBytes.length && timingSafeEqual(contentBytes, expectedBytes)
  );
}
