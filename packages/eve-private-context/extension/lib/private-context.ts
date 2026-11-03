import type { ApprovalStatus, ConnectionToolAnnotations } from "eve/tools/approval";

/** The result can contain the caller's private data, read with their own credentials. */
export const PERSONAL_TAG = "reads:personal";
/** The call changes state or sends data outside the session. */
export const EXTERNAL_TAG = "effect:external";
/** The call moves data somewhere bulk or persistent: an export, an upload, a share. */
export const EXPORT_TAG = "effect:export";

/** Most sources the state keeps. The newest win. */
export const MAX_SOURCES = 20;

/** Owner recorded for a personal read whose caller eve didn't know. */
export const UNKNOWN_OWNER = "unknown";

export const AUDIENCE_DENIED_REASON =
  "This conversation is visible outside its participants, so personal data can't be read here.";

/** Whose private data this session's model has read. */
export interface PersonalContext {
  /** Principal id of the latest message's sender, whose credentials the turn's calls use. */
  readonly caller: string | undefined;
  /** Principal ids whose data the session read, deduplicated. */
  readonly owners: readonly string[];
  /** Tool names that read it, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sources: readonly string[];
  /** Personal reads requested but not settled yet, by call id, with their tool names. */
  readonly pending: Readonly<Record<string, string>>;
}

export function initialPersonalContext(): PersonalContext {
  return { caller: undefined, owners: [], pending: {}, sources: [] };
}

/**
 * Whether a call's result can carry someone's personal data. An entry's own tags decide. The
 * built-in `agent` tool has none; it counts, because its copy of the agent has the same tools.
 */
export function readsPersonal(capability: {
  readonly name: string;
  readonly tags?: readonly string[];
}): boolean {
  if (capability.tags !== undefined) return capability.tags.includes(PERSONAL_TAG);
  return capability.name === "agent";
}

/** Records the sender of an admitted message. A delivery with no principal leaves it. */
export function admitted(state: PersonalContext, principalId: string | undefined): PersonalContext {
  return principalId === undefined ? state : { ...state, caller: principalId };
}

export function requested(state: PersonalContext, callId: string, name: string): PersonalContext {
  return { ...state, pending: { ...state.pending, [callId]: name } };
}

/**
 * Settles a pending personal read. Only a completed call returned data: a failed one may have
 * been refused by the service, so it records nothing.
 */
export function settled(state: PersonalContext, callId: string, outcome: string): PersonalContext {
  const name = state.pending[callId];
  if (name === undefined) return state;
  const { [callId]: _, ...pending } = state.pending;
  if (outcome !== "completed") return { ...state, pending };
  const owner = state.caller ?? UNKNOWN_OWNER;
  return {
    ...state,
    owners: state.owners.includes(owner) ? state.owners : [...state.owners, owner],
    pending,
    sources: [...state.sources.filter((source) => source !== name), name].slice(-MAX_SOURCES),
  };
}

/** Options for `privateContextPolicy()`. */
export interface PrivateContextPolicyOptions {
  /**
   * How a session holding personal data treats a connection tool with no tags.
   * `"treat-as-write"` asks unless the server marks the tool `readOnlyHint: true`.
   * Default `"treat-as-write"`.
   */
  readonly untaggedConnections?: "ignore" | "treat-as-write";
}

/** Options for `audiencePolicy()`. */
export interface AudiencePolicyOptions {
  /** How to treat a conversation eve couldn't classify. Default `"public"`. */
  readonly treatUnknownAs?: "public" | "private";
}

/** The parts of an approval context the decisions read. */
export interface DecisionInput {
  readonly toolName: string;
  readonly toolTags?: readonly string[];
  readonly toolAnnotations?: ConnectionToolAnnotations;
}

/** Asks before a write once the session holds someone's personal data. */
export function decidePrivateContext(
  state: PersonalContext,
  call: DecisionInput,
  options: PrivateContextPolicyOptions = {},
): ApprovalStatus {
  if (state.sources.length === 0) return undefined;
  const tags = call.toolTags;
  if (tags?.includes(EXPORT_TAG) || tags?.includes(EXTERNAL_TAG)) return "user-approval";
  if (
    tags === undefined &&
    (options.untaggedConnections ?? "treat-as-write") === "treat-as-write" &&
    isConnectionTool(call) &&
    call.toolAnnotations?.readOnlyHint !== true
  ) {
    return "user-approval";
  }
  return undefined;
}

/** Denies a personal read in a conversation others can see. */
export function decideAudience(
  audience: "public" | "private" | "unknown",
  call: DecisionInput,
  options: AudiencePolicyOptions = {},
): ApprovalStatus {
  const effective = audience === "unknown" ? (options.treatUnknownAs ?? "public") : audience;
  if (effective === "private" || call.toolTags?.includes(PERSONAL_TAG) !== true) return undefined;
  return { reason: AUDIENCE_DENIED_REASON, type: "denied" };
}

/**
 * Connection tools are the ones a server describes, or are named `<connection>__<tool>`. The name
 * also matches mounted extension tools, which errs toward asking.
 */
function isConnectionTool(call: DecisionInput): boolean {
  if (call.toolAnnotations !== undefined) return true;
  return call.toolName.includes("__") && !call.toolName.startsWith("eve__");
}

/** How strict a status is: denied, then user approval, then approved, then no answer. */
export function strictness(status: ApprovalStatus): number {
  const type = typeof status === "object" ? status.type : status;
  if (type === "denied" || type === false) return 3;
  if (type === "user-approval") return 2;
  if (type === "approved" || type === true) return 1;
  return 0;
}

/** The strictest of `statuses`, the first of equals so its reason survives. */
export function strictestOf(statuses: readonly ApprovalStatus[]): ApprovalStatus {
  let strictest: ApprovalStatus = undefined;
  for (const status of statuses) {
    if (strictness(status) > strictness(strictest)) strictest = status;
  }
  return strictest;
}
