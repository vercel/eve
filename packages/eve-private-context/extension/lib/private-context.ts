import type { ApprovalStatus, ConnectionToolAnnotations } from "eve/tools/approval";

/**
 * The result can contain sensitive company data. MCP: trust annotations `sensitive: true`, a
 * `confidential` or `highly_confidential` data class, SEP-2061 sensitivity `Financial`,
 * `Credentials`, or `Regulated`; FIDES `private`.
 */
export const SENSITIVE_TAG = "reads:sensitive";
/**
 * The result can contain the caller's private data, read with their own credentials. Above
 * {@link SENSITIVE_TAG}. MCP: a `personal` data class, SEP-2061 sensitivity `PII` or `User`;
 * FIDES `user_identity`.
 */
export const PERSONAL_TAG = "reads:personal";
/** The call can put data somewhere publicly accessible. SEP-2061 destination `Public`. */
export const PUBLIC_SINK_TAG = "sink:public";
/** The call puts data where a restricted internal audience sees it. SEP-2061 `Internal`. */
export const INTERNAL_SINK_TAG = "sink:internal";
/** The call puts data where only the end user sees it. SEP-2061 `User`. */
export const USER_SINK_TAG = "sink:user";
/** The call changes state or sends data outside the session. `readOnlyHint: false`. */
export const EXTERNAL_TAG = "effect:external";
/** The call can't be undone. It counts as external too. `destructiveHint: true`. */
export const IRREVERSIBLE_TAG = "effect:irreversible";

/** Most sources the state keeps per level. The newest win. */
export const MAX_SOURCES = 20;

/** Owner recorded for a personal read whose caller eve didn't know. */
export const UNKNOWN_OWNER = "unknown";

export const PERSONAL_AUDIENCE_REASON =
  "This conversation is visible outside its participants, so personal data can't be read here.";
export const SENSITIVE_AUDIENCE_REASON =
  "This conversation is visible outside the organization, so sensitive data can't be read here.";

/** How confidential the data a read returns is, lowest first. */
export type ReadLevel = "sensitive" | "personal";

/** Who may see what a sink receives, lowest first. */
export type SinkCap = "public" | "internal" | "user";

/** What confidential data this session's model has read. */
export interface PersonalContext {
  /** Principal id of the latest message's sender, whose credentials the turn's calls use. */
  readonly caller: string | undefined;
  /** Principal ids whose personal data the session read, deduplicated. */
  readonly owners: readonly string[];
  /** Tool names that read personal data, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sources: readonly string[];
  /** Whether the session read sensitive company data. */
  readonly sensitive: boolean;
  /** Tool names that read it, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sensitiveSources: readonly string[];
  /** Reads requested but not settled yet, by call id, with their tool names and levels. */
  readonly pending: Readonly<Record<string, { readonly name: string; readonly level: ReadLevel }>>;
}

export function initialPersonalContext(): PersonalContext {
  return {
    caller: undefined,
    owners: [],
    pending: {},
    sensitive: false,
    sensitiveSources: [],
    sources: [],
  };
}

/**
 * How confidential a call's result can be. An entry's own tags decide. The built-in `agent` tool
 * has none; it counts as personal, because its copy of the agent has the same tools.
 */
export function readLevelOf(capability: {
  readonly name: string;
  readonly tags?: readonly string[];
}): ReadLevel | undefined {
  const { name, tags } = capability;
  if (tags === undefined) return name === "agent" ? "personal" : undefined;
  return levelOfTags(tags);
}

function levelOfTags(tags: readonly string[]): ReadLevel | undefined {
  if (tags.includes(PERSONAL_TAG)) return "personal";
  return tags.includes(SENSITIVE_TAG) ? "sensitive" : undefined;
}

/** Records the sender of an admitted message. A delivery with no principal leaves it. */
export function admitted(state: PersonalContext, principalId: string | undefined): PersonalContext {
  return principalId === undefined ? state : { ...state, caller: principalId };
}

export function requested(
  state: PersonalContext,
  callId: string,
  name: string,
  level: ReadLevel,
): PersonalContext {
  return { ...state, pending: { ...state.pending, [callId]: { level, name } } };
}

/**
 * Settles a pending read. Only a completed call returned data: a failed one may have been refused
 * by the service, so it records nothing.
 */
export function settled(state: PersonalContext, callId: string, outcome: string): PersonalContext {
  const read = state.pending[callId];
  if (read === undefined) return state;
  const { [callId]: _, ...pending } = state.pending;
  if (outcome !== "completed") return { ...state, pending };
  const add = (sources: readonly string[]) =>
    [...sources.filter((source) => source !== read.name), read.name].slice(-MAX_SOURCES);
  if (read.level === "sensitive") {
    return { ...state, pending, sensitive: true, sensitiveSources: add(state.sensitiveSources) };
  }
  const owner = state.caller ?? UNKNOWN_OWNER;
  return {
    ...state,
    owners: state.owners.includes(owner) ? state.owners : [...state.owners, owner],
    pending,
    sources: add(state.sources),
  };
}

/** Options shared by the policies that check where data goes. */
export interface SinkOptions {
  /**
   * How to treat a connection tool with no tags. `"treat-as-write"` counts it as a sink capped at
   * public unless the server marks it `readOnlyHint: true`. Default `"treat-as-write"`.
   */
  readonly untaggedConnections?: "ignore" | "treat-as-write";
}

/** Options for `privateContextPolicy()`. */
export interface PrivateContextPolicyOptions extends SinkOptions {
  /**
   * What a call that sends sensitive company data past its sink's cap gets. `"allow"` leaves it to
   * other policies, such as `untrustedContentPolicy({ when: exceedsCap })` for the Rule of Two.
   * Personal data past a cap always asks. Default `"ask"`.
   */
  readonly sensitiveFlows?: "ask" | "allow";
}

/** Options for `audiencePolicy()`. */
export interface AudiencePolicyOptions {
  /**
   * Who to assume can see a conversation eve couldn't classify. `"external"` denies sensitive and
   * personal reads, `"internal"` denies personal reads, and `"private"` allows both.
   * Default `"external"`.
   */
  readonly treatUnknownAs?: "external" | "internal" | "private";
}

/** The parts of an approval context the decisions read. */
export interface DecisionInput {
  readonly toolName: string;
  readonly toolTags?: readonly string[];
  readonly toolAnnotations?: ConnectionToolAnnotations;
}

/**
 * Who may see what a call sends, or `undefined` when the call isn't an exit point. A `sink:*` tag
 * sets the cap; any other external call is capped at public.
 */
export function sinkCapOf(call: DecisionInput, options: SinkOptions = {}): SinkCap | undefined {
  const tags = call.toolTags;
  if (tags === undefined) {
    const writes =
      (options.untaggedConnections ?? "treat-as-write") === "treat-as-write" &&
      isConnectionTool(call) &&
      call.toolAnnotations?.readOnlyHint !== true;
    return writes ? "public" : undefined;
  }
  if (tags.includes(PUBLIC_SINK_TAG)) return "public";
  if (tags.includes(INTERNAL_SINK_TAG)) return "internal";
  if (tags.includes(USER_SINK_TAG)) return "user";
  return tags.includes(EXTERNAL_TAG) || tags.includes(IRREVERSIBLE_TAG) ? "public" : undefined;
}

/**
 * The most confidential data a call would send past its sink's cap, or `undefined` when the
 * session's data may go there. Personal data may go to a `sink:user` only when everyone it
 * belongs to is `caller`, the user that sink shows it to.
 */
export function exceeded(
  state: PersonalContext,
  call: DecisionInput,
  caller: string | undefined,
  options: SinkOptions = {},
): ReadLevel | undefined {
  const cap = sinkCapOf(call, options);
  if (cap === undefined) return undefined;
  if (state.sources.length > 0) {
    const toOwner = cap === "user" && state.owners.every((owner) => owner === caller);
    if (!toOwner) return "personal";
  }
  return state.sensitive && cap === "public" ? "sensitive" : undefined;
}

/** Asks before a call that would send confidential data past its sink's cap. */
export function decidePrivateContext(
  state: PersonalContext,
  call: DecisionInput,
  caller: string | undefined,
  options: PrivateContextPolicyOptions = {},
): ApprovalStatus {
  const level = exceeded(state, call, caller, options);
  if (level === "personal") {
    return {
      reason: `This session read personal data belonging to ${state.owners.join(", ")} from ${state.sources.join(", ")}, and this call could share it with others.`,
      type: "user-approval",
    };
  }
  if (level === "sensitive" && options.sensitiveFlows !== "allow") {
    return {
      reason: `This session read sensitive data from ${state.sensitiveSources.join(", ")}, and this call could make it public.`,
      type: "user-approval",
    };
  }
  return undefined;
}

/**
 * Denies a read the conversation's readers shouldn't see. eve's `public` means visible in the
 * workspace, so it allows sensitive data but not personal data.
 */
export function decideAudience(
  audience: "public" | "private" | "unknown",
  call: DecisionInput,
  options: AudiencePolicyOptions = {},
): ApprovalStatus {
  const level = call.toolTags === undefined ? undefined : levelOfTags(call.toolTags);
  if (level === undefined) return undefined;
  const readers =
    audience === "private"
      ? "private"
      : audience === "public"
        ? "internal"
        : (options.treatUnknownAs ?? "external");
  if (readers === "private") return undefined;
  if (level === "personal") return { reason: PERSONAL_AUDIENCE_REASON, type: "denied" };
  return readers === "external" ? { reason: SENSITIVE_AUDIENCE_REASON, type: "denied" } : undefined;
}

/**
 * Connection tools are the ones a server describes, or are named `<connection>__<tool>`. The name
 * also matches mounted extension tools, which errs toward asking.
 */
function isConnectionTool(call: DecisionInput): boolean {
  if (call.toolAnnotations !== undefined) return true;
  return call.toolName.includes("__") && !call.toolName.startsWith("eve__");
}

/** Most characters of a comma-joined sources span attribute. */
export const MAX_SOURCES_ATTRIBUTE_LENGTH = 256;

/**
 * Span attributes for what confidential data the session holds. Owners stay out: they're
 * principal ids, which would put personal identifiers into traces.
 */
export function runtimeContextOf(state: PersonalContext): {
  readonly "private.sensitive": boolean;
  readonly "private.sensitive_sources": string;
  readonly "private.personal": boolean;
  readonly "private.personal_sources": string;
} {
  return {
    "private.sensitive": state.sensitive,
    "private.sensitive_sources": joined(state.sensitiveSources),
    "private.personal": state.sources.length > 0,
    "private.personal_sources": joined(state.sources),
  };
}

function joined(sources: readonly string[]): string {
  const value = sources.join(",");
  return value.length > MAX_SOURCES_ATTRIBUTE_LENGTH
    ? `${value.slice(0, MAX_SOURCES_ATTRIBUTE_LENGTH - 1)}…`
    : value;
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
