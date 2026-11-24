import {
  steered,
  type ApprovalConfiguration,
  type ApprovalContext,
  type ApprovalResponsePolicy,
} from "eve/tools/approval";

import { SkillLifecycleError } from "./errors.ts";
import type {
  SkillApprovalDecision,
  SkillApprovalRequest,
  SkillApprovalRule,
  SkillApprovalTarget,
  SkillScope,
} from "./types.ts";

/**
 * Asks before publishing, rolling back, or removing a skill, and before any
 * change goes live in a shared scope. A personal first version and a personal
 * mode change run without asking, and a draft never needs approval. A shared
 * change whose approval card can't show it in full is refused, so nobody
 * approves text they couldn't read.
 */
export const defaultSkillApproval: SkillApprovalRule = (request) => {
  if (!request.changesLive) return "allow";
  if (request.scope.shared) {
    const length = fullApprovalCard(request).length;
    if (length > MAX_CARD) {
      return {
        deny: `This change's approval card would be ${length} characters, more than the ${MAX_CARD} an approver can read in full. Shorten the skill's description or instructions before it goes live for ${request.scope.label}.`,
      };
    }
    return "ask";
  }
  return request.action === "create" || request.action === "set_mode" ? "allow" : "ask";
};

export const defaultSkillResponse: ApprovalResponsePolicy = ({ request, response }) => {
  const requester = request.principal;
  const responder = response.principal;
  return requester === null ||
    (requester.authenticator === responder.authenticator &&
      (requester.issuer ?? "") === (responder.issuer ?? "") &&
      requester.principalType === responder.principalType &&
      requester.principalId === responder.principalId &&
      (requester.subject ?? "") === (responder.subject ?? ""))
    ? { status: "allowed" }
    : { status: "rejected", reason: "Only the person who asked can approve this change." };
};

const MAX_CARD = 3_000;
const MAX_PREVIEW = 2_000;

function preview(text: string | undefined, limit: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}…\n(Showing the first ${limit} of ${trimmed.length} characters.)`;
}

function modeLabel(mode: string | null | undefined): string {
  if (mode === "always") return "always on";
  if (mode === "deferred") return "found by search";
  return "loaded on demand";
}

function targetLines(target: SkillApprovalTarget, limit: number): string[] {
  const lines: string[] = [];
  if (target.description) lines.push(`Description: ${target.description}`);
  const instructions = preview(target.instructions, limit);
  if (instructions) lines.push(`Instructions:\n${instructions}`);
  if (target.warnings.length > 0) lines.push(`Warnings: ${target.warnings.join(" ")}`);
  return lines;
}

export function approvalCard(request: SkillApprovalRequest): string {
  const full = fullApprovalCard(request);
  if (full.length <= MAX_CARD) return full;
  const card = composeCard(request, MAX_PREVIEW);
  return card.length <= MAX_CARD ? card : `${card.slice(0, MAX_CARD - 1).trimEnd()}…`;
}

function fullApprovalCard(request: SkillApprovalRequest): string {
  return composeCard(request, Number.POSITIVE_INFINITY);
}

function composeCard(request: SkillApprovalRequest, limit: number): string {
  const { action, scope } = request;
  const forWhom = scope.shared ? `for ${scope.label}` : "for you";
  const [target] = request.targets;
  let headline: string;
  let body: string[] = [];
  if (action === "remove") {
    const names = request.targets.map(({ name }) => `"${name}"`).join(", ");
    headline = `Delete ${request.targets.length === 1 ? "skill" : "skills"} ${names} ${forWhom}, with every version?`;
    body = request.targets.flatMap(({ name, live }) =>
      live.version === null
        ? []
        : [`"${name}" v${live.version} is live (${modeLabel(live.applicationMode)}).`],
    );
  } else if (!target) {
    headline = `Change custom skills ${forWhom}?`;
  } else if (action === "set_mode") {
    headline = `Make "${target.name}" v${target.version} ${modeLabel(target.applicationMode)} ${forWhom}? It is ${modeLabel(target.live.applicationMode)} now.`;
    body = targetLines({ ...target, description: undefined }, limit);
  } else {
    const verb =
      action === "create"
        ? request.changesLive
          ? "Save and turn on"
          : "Save a draft of"
        : action === "rollback"
          ? "Roll back"
          : "Publish";
    const replaces =
      target.live.version === null ? "" : ` It replaces live v${target.live.version}.`;
    headline =
      action === "rollback"
        ? `Roll back "${target.name}" ${forWhom} to v${target.version}, ${modeLabel(target.applicationMode)}?${replaces}`
        : `${verb} "${target.name}" v${target.version} ${forWhom}, ${modeLabel(target.applicationMode)}?${replaces}`;
    body = targetLines(target, limit);
  }
  return [headline, ...body].join("\n\n");
}

export interface PlannedChange<TPlan> {
  readonly scope: SkillScope;
  readonly request: SkillApprovalRequest;
  readonly plan: TPlan;
}

const cards = new Map<string, { sessionId: string; card: string } | "ambiguous">();
const MAX_CARDS = 256;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function cardKey(toolName: string, callId: string, input: unknown): string {
  return JSON.stringify([toolName, callId, canonical(input)]);
}

function rememberCard(key: string, sessionId: string, card: string): void {
  const existing = cards.get(key);
  cards.delete(key);
  cards.set(
    key,
    existing !== undefined && (existing === "ambiguous" || existing.sessionId !== sessionId)
      ? "ambiguous"
      : { sessionId, card },
  );
  while (cards.size > MAX_CARDS) {
    const oldest = cards.keys().next().value;
    if (oldest === undefined) break;
    cards.delete(oldest);
  }
}

function takeCard(key: string): string | undefined {
  const entry = cards.get(key);
  cards.delete(key);
  return entry === undefined || entry === "ambiguous" ? undefined : entry.card;
}

function toEveStatus(decision: SkillApprovalDecision) {
  if (decision === "allow") return "not-applicable" as const;
  if (decision === "ask") return "user-approval" as const;
  return { type: "denied", reason: decision.deny } as const;
}

const whenSteered = steered();

export function skillApproval<TInput extends object, TPlan>(input: {
  readonly plan: (ctx: ApprovalContext<TInput>, input: TInput) => Promise<PlannedChange<TPlan>>;
  readonly rule: () => SkillApprovalRule;
  readonly response: () => ApprovalResponsePolicy;
  readonly fallbackCard: (input: TInput) => string;
}): ApprovalConfiguration<TInput> {
  return {
    async request(ctx) {
      if (ctx.toolInput === undefined) return "user-approval";
      const toolInput = ctx.toolInput as TInput;
      let planned: PlannedChange<TPlan>;
      try {
        planned = await input.plan(ctx, toolInput);
      } catch (error) {
        if (error instanceof SkillLifecycleError) return "not-applicable";
        throw error;
      }
      const decision = await input.rule()(planned.request);
      const steeredStatus =
        decision === "allow" || decision === "ask" ? await whenSteered(ctx) : undefined;
      const status =
        decision === "allow"
          ? (steeredStatus ?? toEveStatus(decision))
          : decision === "ask" &&
              typeof steeredStatus === "object" &&
              steeredStatus.type === "denied"
            ? steeredStatus
            : toEveStatus(decision);
      if (status === "user-approval") {
        rememberCard(
          cardKey(ctx.toolName, ctx.callId, toolInput),
          ctx.session.id,
          approvalCard(planned.request),
        );
      }
      return status;
    },
    prompt: ({ callId, input: toolInput, toolName }) =>
      takeCard(cardKey(toolName, callId, toolInput)) ?? input.fallbackCard(toolInput),
    response: (ctx) => input.response()(ctx as Parameters<ApprovalResponsePolicy>[0]),
  };
}
