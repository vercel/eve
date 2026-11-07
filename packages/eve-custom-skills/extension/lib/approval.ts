import type { SessionAuthContext } from "eve/context";
import type {
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalResponsePolicy,
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
 * mode change run without asking, and a draft never needs approval.
 */
export const defaultSkillApproval: SkillApprovalRule = (request) => {
  if (!request.changesLive) return "allow";
  if (request.scope.shared) return "ask";
  return request.action === "create" || request.action === "set_mode" ? "allow" : "ask";
};

function samePrincipal(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    (left.issuer ?? "") === (right.issuer ?? "") &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

/** eve's default: only the person who asked may answer. */
export const requesterOnly: ApprovalResponsePolicy = ({ request, response }) =>
  request.principal === null || samePrincipal(request.principal, response.principal)
    ? { status: "allowed" }
    : { status: "rejected", reason: "Only the person who asked can approve this change." };

const MAX_PREVIEW = 600;
const MAX_CARD = 2_500;

function preview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  return trimmed.length <= MAX_PREVIEW ? trimmed : `${trimmed.slice(0, MAX_PREVIEW).trimEnd()}…`;
}

function modeLabel(mode: string | null | undefined): string {
  if (mode === "always") return "always on";
  if (mode === "deferred") return "found by search";
  return "loaded on demand";
}

function targetLines(target: SkillApprovalTarget): string[] {
  const lines: string[] = [];
  if (target.description) lines.push(`Description: ${target.description}`);
  const instructions = preview(target.instructions);
  if (instructions) lines.push(`Instructions:\n${instructions}`);
  if (target.warnings.length > 0) lines.push(`Warnings: ${target.warnings.join(" ")}`);
  return lines;
}

/** The approval card for a change: what it does, for whom, and the content that will apply. */
export function approvalCard(request: SkillApprovalRequest): string {
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
    body = targetLines({ ...target, description: undefined });
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
    body = targetLines(target);
  }
  const card = [headline, ...body].join("\n\n");
  return card.length <= MAX_CARD ? card : `${card.slice(0, MAX_CARD - 1).trimEnd()}…`;
}

/** What a change would do, for the approval rule, the card, and the tool that runs it. */
export interface PlannedChange<TPlan> {
  readonly scope: SkillScope;
  readonly request: SkillApprovalRequest;
  readonly plan: TPlan;
}

/**
 * Cards made by the request policy, for the prompt to show. The prompt only
 * sees the call ID, tool name, and input, so two sessions with the same call
 * ID and input can't be told apart: their card falls back to a plain one.
 */
const cards = new Map<string, { sessionId: string; card: string } | "ambiguous">();
const MAX_CARDS = 256;

/** JSON with sorted keys: the policy sees parsed input and the prompt the model's, in any key order. */
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

/**
 * The approval for a lifecycle tool: the configured rule decides from the
 * planned change, the card shows its content, and the response rule decides
 * who may answer. A change that can't be planned runs without asking, so the
 * tool reports why it fails.
 */
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
      if (decision === "ask") {
        rememberCard(
          cardKey(ctx.toolName, ctx.callId, toolInput),
          ctx.session.id,
          approvalCard(planned.request),
        );
      }
      return toEveStatus(decision);
    },
    prompt: ({ callId, input: toolInput, toolName }) =>
      takeCard(cardKey(toolName, callId, toolInput)) ?? input.fallbackCard(toolInput),
    response: (ctx) => input.response()(ctx as Parameters<ApprovalResponsePolicy>[0]),
  };
}
