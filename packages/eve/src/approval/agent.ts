import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalResponsePolicy,
  type ApprovalStatus,
  resolveApprovalPolicy,
} from "#approval/definition.js";
import { requesterOnlyResponse } from "#approval/requester-only.js";
import { normalizeApprovalStatus } from "#approval/status.js";
import { contextStorage } from "#context/container.js";
import { SteeredByKey } from "#context/keys.js";
import { isSteeredApprovalPolicy, markSteeredApprovalPolicy } from "#tools/approval/policies.js";

function rank(status: ApprovalStatus): number {
  const normalized = normalizeApprovalStatus(status);
  const type = typeof normalized === "object" ? normalized.type : normalized;
  if (type === "denied") return 3;
  if (type === "user-approval") return 2;
  if (type === "approved") return 1;
  return 0;
}

export function strictestApproval(policies: readonly ApprovalPolicy[]): ApprovalPolicy {
  const combined: ApprovalPolicy = async (ctx) => {
    let strictest: ApprovalStatus = undefined;
    for (const policy of policies) {
      const status = await policy(ctx);
      if (rank(status) >= rank(strictest)) strictest = status;
      if (rank(strictest) === 3) break;
    }
    return strictest;
  };
  return policies.some(isSteeredApprovalPolicy) ? markSteeredApprovalPolicy(combined) : combined;
}

function withSteeredResponseGuard<TInput>(
  response: ApprovalResponsePolicy<TInput>,
): ApprovalResponsePolicy<TInput> {
  return (ctx) => {
    if ((contextStorage.getStore()?.get(SteeredByKey) ?? []).length > 0) {
      const callerOnly = requesterOnlyResponse(ctx);
      if (callerOnly.status === "rejected") return callerOnly;
    }
    return response(ctx);
  };
}

export function withAgentApproval(
  agent: ApprovalPolicy | undefined,
  own: Approval | undefined,
): Approval | undefined {
  if (agent === undefined) return own;
  if (own === undefined) return agent;
  const ownRequest = resolveApprovalPolicy(own);
  const request = strictestApproval([agent, ownRequest]);
  if (typeof own === "function") return request;
  const steeredGuard = isSteeredApprovalPolicy(agent) || isSteeredApprovalPolicy(ownRequest);
  if (own.response === undefined || !steeredGuard) return { ...own, request };
  return { ...own, request, response: withSteeredResponseGuard(own.response) };
}

export function withAgentApprovalOnEntries<
  T extends {
    readonly agentApprovalIncluded?: boolean;
    readonly approval?: Approval;
    readonly frameworkAction?: unknown;
    readonly interactionOnly?: boolean;
  },
>(entries: ReadonlyMap<string, T>, agent: ApprovalPolicy | undefined): Map<string, T> {
  if (agent === undefined) return new Map(entries);
  return new Map(
    [...entries].map(([name, entry]) => [
      name,
      entry.agentApprovalIncluded === true ||
      entry.frameworkAction !== undefined ||
      entry.interactionOnly === true
        ? entry
        : { ...entry, approval: withAgentApproval(agent, entry.approval) },
    ]),
  );
}
