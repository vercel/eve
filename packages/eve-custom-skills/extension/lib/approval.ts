import type { SessionAuthContext } from "eve/context";
import type {
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalResponsePolicy,
} from "eve/tools/approval";

import { SkillChangeRefusedError, SkillLifecycleError } from "./errors.ts";
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

/** One account: the stable identity fields, without the `subject`, which can change (a renamed GitHub login). */
function sameAccount(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    (left.issuer ?? "") === (right.issuer ?? "") &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

/**
 * Why `responder` may not approve `requester`'s change, if they may not. Each
 * side errs toward refusing: a shared change needs a different account, so a
 * changed `subject` doesn't pass as a second person, and a personal change
 * needs the same full identity its scope was keyed by.
 */
export function responderRefusal(
  shared: boolean,
  requester: SessionAuthContext | null,
  responder: SessionAuthContext,
): string | undefined {
  if (requester === null) return undefined;
  if (shared) {
    return sameAccount(requester, responder)
      ? "A change to shared skills needs someone other than the person who asked to approve it."
      : undefined;
  }
  return sameAccount(requester, responder) &&
    (requester.subject ?? "") === (responder.subject ?? "")
    ? undefined
    : "Only the person who asked can approve a change to their own skills.";
}

/**
 * Who may answer by default. A personal change is the asker's alone. A change
 * to a shared scope needs a second person, so no one member can put text into
 * everyone's prompt by approving it themselves. `isShared` reports whether the
 * call targets a shared scope; a scope it can't resolve counts as shared.
 */
export function defaultSkillResponse(
  isShared: (ctx: Parameters<ApprovalResponsePolicy>[0]) => Promise<boolean>,
): ApprovalResponsePolicy {
  return async (ctx) => {
    const reason = responderRefusal(
      await isShared(ctx),
      ctx.request.principal,
      ctx.response.principal,
    );
    return reason === undefined ? { status: "allowed" } : { status: "rejected", reason };
  };
}

// Slack section text, the tightest card eve renders, holds 3,000 characters.
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

/**
 * The approval card for a change: what it does, for whom, and the content that
 * will apply. A card too long to show whole previews the instructions; a shared
 * change's default rule refuses one, so its approver always reads everything.
 */
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

/**
 * Re-checks who approved, once the change runs with its real scope. A response
 * is judged without the conversation, so a scope that depends on it, such as
 * a custom personal scope keyed by the channel, may have been taken for a
 * shared one: here a personal change still needs its asker, and a shared one
 * someone else.
 */
export function requireDefaultResponder(
  scope: SkillScope,
  requester: SessionAuthContext | null,
  responder: SessionAuthContext,
): void {
  const reason = responderRefusal(scope.shared, requester, responder);
  if (reason !== undefined) throw new SkillChangeRefusedError(reason);
}
