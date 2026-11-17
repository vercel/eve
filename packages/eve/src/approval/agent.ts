import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalStatus,
  resolveApprovalPolicy,
} from "#approval/definition.js";
import { normalizeApprovalStatus } from "#approval/status.js";

function rank(status: ApprovalStatus): number {
  const normalized = normalizeApprovalStatus(status);
  const type = typeof normalized === "object" ? normalized.type : normalized;
  if (type === "denied") return 3;
  if (type === "user-approval") return 2;
  if (type === "approved") return 1;
  return 0;
}

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

export function withAgentApproval(
  agent: ApprovalPolicy | undefined,
  own: Approval | undefined,
): Approval | undefined {
  if (agent === undefined) return own;
  if (own === undefined) return agent;
  const request = strictestApproval([agent, resolveApprovalPolicy(own)]);
  return typeof own === "function" ? request : { ...own, request };
}

export function withAgentApprovalOnEntries<
  T extends {
    readonly approval?: Approval;
    readonly frameworkAction?: unknown;
    readonly interactionOnly?: boolean;
  },
>(entries: ReadonlyMap<string, T>, agent: ApprovalPolicy | undefined): Map<string, T> {
  if (agent === undefined) return new Map(entries);
  return new Map(
    [...entries].map(([name, entry]) => [
      name,
      entry.frameworkAction !== undefined || entry.interactionOnly === true
        ? entry
        : { ...entry, approval: withAgentApproval(agent, entry.approval) },
    ]),
  );
}
