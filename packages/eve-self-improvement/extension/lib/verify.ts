import { isDeepStrictEqual } from "node:util";
import { Client } from "eve/client";
import type { Config } from "./config.js";
import { Vercel, assertDeployment } from "./providers.js";
import { compareMetrics } from "./gates.js";
import type { Candidate, Check, Deployment, Receipt, RuntimeProof } from "./types.js";

export async function authenticatedSmoke(
  c: Config,
  deployment: Deployment,
  origin = deployment.url,
): Promise<Check> {
  assertDeployment(c, deployment, deployment.sha, deployment.environment);
  if (origin !== deployment.url && origin !== c.project.productionUrl)
    throw new Error("Smoke origin is outside the verified deployment");
  const smoke = c.verification.smoke;
  if (!smoke || !c.verification.authHeaders)
    return {
      name: "fresh authenticated tool",
      status: "unavailable",
      reason: "Configure an authenticated deterministic tool smoke test",
    };
  const headers = await c.verification.authHeaders(deployment.environment);
  if (!Object.keys(headers).some((key) => /authorization|cookie|x-api-key/i.test(key)))
    return {
      name: "fresh authenticated tool",
      status: "failed",
      reason:
        "No application authentication headers supplied; protection bypass alone is insufficient",
    };
  const client = new Client({ baseUrl: origin, headers, redirect: "error" });
  await client.health();
  const { session, delivery } = await client.sessions.create({ message: smoke.message });
  const result = await delivery.result({ signal: AbortSignal.timeout(90000) });
  if (result.status !== "completed")
    return {
      name: "fresh authenticated tool",
      status: "failed",
      reason: "Fresh authenticated session did not complete",
    };
  const requested = new Set<string>();
  let executed = false;
  for await (const event of client.sessions
    .attach(session.id)
    .stream({ follow: false, signal: AbortSignal.timeout(30000) })) {
    if (
      event.type === "call.requested" &&
      event.data.capability.kind === "tool" &&
      event.data.capability.name === smoke.toolName
    )
      requested.add(event.data.callId);
    if (
      event.type === "call.settled" &&
      requested.has(event.data.callId) &&
      event.data.outcome === "completed" &&
      isDeepStrictEqual(event.data.output, smoke.expectedOutput)
    )
      executed = true;
  }
  return {
    name: "fresh authenticated tool",
    status: executed ? "passed" : "failed",
    reason: executed
      ? `Actual ${smoke.toolName} call/result verified in a fresh session stream`
      : "Model prose was not accepted as evidence of tool execution",
  };
}
export function receiptValid(receipt: Receipt | undefined, expectedId?: string): boolean {
  if (
    !receipt ||
    !["sent", "already-sent"].includes(receipt.status) ||
    !receipt.id ||
    (expectedId !== undefined && receipt.id !== expectedId)
  )
    return false;
  try {
    return new URL(receipt.url).protocol === "https:";
  } catch {
    return false;
  }
}
export async function verifyChange(
  c: Config,
  candidate: Candidate,
  platform = new Vercel(c),
): Promise<Check[]> {
  const preview = await platform.preview(candidate.head);
  if (!preview)
    return [
      {
        name: "exact preview",
        status: "pending",
        reason: "No READY immutable preview matches the candidate head/project/team",
      },
    ];
  const checks: Check[] = [
    {
      name: "exact preview",
      status: "passed",
      reason: `Confirmed ${preview.id} at ${candidate.head}`,
      url: preview.url,
    },
  ];
  try {
    checks.push(await authenticatedSmoke(c, preview));
  } catch {
    checks.push({
      name: "fresh authenticated tool",
      status: "failed",
      reason: "Authenticated preview smoke failed; response and credentials withheld",
    });
  }
  if (!c.verification.change)
    checks.push({
      name: "change-specific regression",
      status: "unavailable",
      reason: "Provide a trusted executable before/after regression or representative evaluator",
    });
  else {
    const proof = await c.verification.change({ baseline: candidate.base, candidate, preview });
    checks.push({
      name: "change-specific regression",
      status: proof.head === candidate.head ? proof.status : "failed",
      reason:
        proof.head === candidate.head
          ? proof.reason
          : "Regression evidence belongs to another head",
    });
    if (proof.metrics)
      checks.push(compareMetrics(proof.metrics.before, proof.metrics.after, proof.metrics.target));
  }
  await platform.deployment(preview.id, candidate.head, "preview");
  return checks;
}
export async function verifyRelease(
  c: Config,
  deployment: Deployment,
  input: {
    baseline?: Deployment;
    delivery?: boolean;
    deliveryId?: string;
    immutable?: boolean;
  } = {},
): Promise<{ checks: Check[]; runtime?: RuntimeProof }> {
  const platform = new Vercel(c),
    checks: Check[] = [];
  assertDeployment(c, deployment, deployment.sha, "production");
  const current = await platform.deployment(
    input.immutable ? deployment.id : c.project.productionUrl,
    deployment.sha,
    "production",
  );
  if (current.id !== deployment.id)
    throw new Error(
      "Production alias moved concurrently; stop and reconcile before release or rollback",
    );
  checks.push({
    name: "production identity",
    status: "passed",
    reason: `Exact project/team/production/source ${deployment.sha}`,
    url: deployment.url,
  });
  try {
    checks.push(
      await authenticatedSmoke(
        c,
        deployment,
        input.immutable ? deployment.url : c.project.productionUrl,
      ),
    );
  } catch {
    checks.push({
      name: "fresh authenticated tool",
      status: "failed",
      reason: "Fresh production health/auth/tool smoke failed; private response withheld",
    });
  }
  let runtime: RuntimeProof | undefined;
  if (c.verification.runtime) {
    try {
      runtime = await c.verification.runtime({ deployment, baseline: input.baseline });
      checks.push({
        name: "production runtime",
        status: runtime.deploymentId === deployment.id ? runtime.status : "failed",
        reason:
          runtime.deploymentId === deployment.id
            ? runtime.reason
            : "Runtime evidence belongs to another deployment",
      });
    } catch {
      checks.push({
        name: "production runtime",
        status: "unavailable",
        reason: "Runtime evidence could not be obtained; inspect private diagnostics",
      });
    }
  } else
    checks.push({
      name: "production runtime",
      status: "unavailable",
      reason: "Runtime error and changed-behavior verifier is not configured",
    });
  if (c.verification.publisher) {
    try {
      checks.push(await c.verification.publisher({ sha: deployment.sha, deployment }));
    } catch {
      checks.push({
        name: "publisher identity",
        status: "unavailable",
        reason: "Publisher snapshot evidence could not be obtained",
      });
    }
  } else
    checks.push({
      name: "publisher identity",
      status: "unavailable",
      reason: "Publisher snapshot verifier is not configured",
    });
  if (input.delivery && c.verification.delivery) {
    const id = input.deliveryId ?? `release:${deployment.id}:${deployment.sha}`;
    try {
      const receipt = await c.verification.delivery({ id, deployment });
      checks.push({
        name: "release delivery",
        status: receiptValid(receipt, id) ? "passed" : "failed",
        reason: receiptValid(receipt, id)
          ? "Confirmed independent idempotent delivery receipt"
          : "Delivery unconfirmed; reconcile the same message ID before retry",
        url: receiptValid(receipt, id) ? receipt.url : undefined,
      });
    } catch {
      checks.push({
        name: "release delivery",
        status: "unavailable",
        reason: "Delivery timed out or is unconfirmed; reconcile the same message ID before retry",
      });
    }
  }
  const final = await platform.deployment(
    input.immutable ? deployment.id : c.project.productionUrl,
    deployment.sha,
    "production",
  );
  if (final.id !== deployment.id)
    throw new Error("Production identity changed during verification");
  return { checks, runtime };
}
