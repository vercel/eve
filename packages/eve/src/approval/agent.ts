import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalStatus,
  resolveApprovalPolicy,
} from "#approval/definition.js";
import { normalizeApprovalStatus } from "#approval/status.js";

/** How restrictive a status is: a denial beats a person, who beats a policy's clearance. */
function rank(status: ApprovalStatus): number {
  const normalized = normalizeApprovalStatus(status);
  const type = typeof normalized === "object" ? normalized.type : normalized;
  if (type === "denied") return 3;
  if (type === "user-approval") return 2;
  if (type === "approved") return 1;
  return 0;
}

/**
 * Runs `policies` in order and returns the most restrictive status, unchanged, so a `once()`
 * status keeps the identity its memory depends on. A denial stops the rest; on a tie the later
 * policy wins, so the entry's own `once()` outranks an agent-wide ask.
 */
export function strictestApproval(policies: readonly ApprovalPolicy[]): ApprovalPolicy {
  return async (ctx) => {
    let strictest: ApprovalStatus = undefined;
    for (const policy of policies) {
      const status = await policy(ctx);
      if (rank(status) >= rank(strictest)) strictest = status;
      if (rank(strictest) === 3) break;
    }
    return strictest;
  };
}

/**
 * The approval an entry runs under with the agent's policy: whichever of the two is stricter. The
 * agent's policy can only add a gate, never remove the entry's own. Without an agent policy the
 * entry keeps its own approval object, so agents that don't author one behave exactly as before.
 */
export function withAgentApproval(
  agent: ApprovalPolicy | undefined,
  own: Approval | undefined,
): Approval | undefined {
  if (agent === undefined) return own;
  if (own === undefined) return agent;
  const request = strictestApproval([agent, resolveApprovalPolicy(own)]);
  return typeof own === "function" ? request : { ...own, request };
}

/**
 * Puts every entry in `entries` under the agent's policy. Task controls (`frameworkAction`) only
 * read or stop work the agent already started, so they stay ungated. Without a policy the entries
 * are returned unchanged.
 */
export function withAgentApprovalOnEntries<
  T extends { readonly approval?: Approval; readonly frameworkAction?: unknown },
>(entries: ReadonlyMap<string, T>, agent: ApprovalPolicy | undefined): Map<string, T> {
  if (agent === undefined) return new Map(entries);
  return new Map(
    [...entries].map(([name, entry]) => [
      name,
      entry.frameworkAction === undefined
        ? { ...entry, approval: withAgentApproval(agent, entry.approval) }
        : entry,
    ]),
  );
}
