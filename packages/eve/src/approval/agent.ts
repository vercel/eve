import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalPresentation,
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
 * The approval an entry runs under with the agent's: whichever policy is stricter, worded by the
 * entry's own `prompt` and `labels`, else the agent's `presentation`. The agent's policy can only add
 * a gate, never remove the entry's own. Without an agent policy or presentation the entry keeps its
 * own approval object, so agents that don't author one behave exactly as before.
 */
export function withAgentApproval(
  agent: ApprovalPolicy | undefined,
  own: Approval | undefined,
  presentation?: ApprovalPresentation,
): Approval | undefined {
  if (agent === undefined && presentation === undefined) return own;
  const ownPolicy = own === undefined ? undefined : resolveApprovalPolicy(own);
  const request =
    agent === undefined || ownPolicy === undefined
      ? (agent ?? ownPolicy)
      : strictestApproval([agent, ownPolicy]);
  // Nothing gates the entry, so there is no approval to word.
  if (request === undefined) return undefined;
  const configured = typeof own === "object" ? own : undefined;
  if (presentation === undefined) {
    return configured === undefined ? request : { ...configured, request };
  }
  const prompt = configured?.prompt ?? presentation.prompt;
  const labels =
    presentation.labels === undefined && configured?.labels === undefined
      ? undefined
      : { ...presentation.labels, ...configured?.labels };
  return {
    ...configured,
    request,
    ...(prompt !== undefined && { prompt }),
    ...(labels !== undefined && { labels }),
  };
}

/**
 * Puts every entry in `entries` under the agent's policy and presentation. Task controls
 * (`frameworkAction`) only read or stop work the agent already started, and built-in interaction
 * executors (`interactionOnly`) act on nothing outside the conversation, so both stay ungated:
 * gating them would ask a person to approve being asked. Without either the entries are unchanged.
 */
export function withAgentApprovalOnEntries<
  T extends {
    readonly approval?: Approval;
    readonly frameworkAction?: unknown;
    readonly interactionOnly?: boolean;
  },
>(
  entries: ReadonlyMap<string, T>,
  agent: ApprovalPolicy | undefined,
  presentation?: ApprovalPresentation,
): Map<string, T> {
  if (agent === undefined && presentation === undefined) return new Map(entries);
  return new Map(
    [...entries].map(([name, entry]) => [
      name,
      entry.frameworkAction !== undefined || entry.interactionOnly === true
        ? entry
        : { ...entry, approval: withAgentApproval(agent, entry.approval, presentation) },
    ]),
  );
}
