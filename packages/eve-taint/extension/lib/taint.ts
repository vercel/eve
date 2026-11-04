import type {
  ApprovalContext,
  ApprovalStatus,
  ConnectionToolAnnotations,
} from "eve/tools/approval";

/** The result can contain text someone outside the trust boundary wrote. */
export const UNTRUSTED_TAG = "reads:untrusted";
/**
 * The call changes state or sends data outside the session. MCP: `readOnlyHint: false`, or an
 * action-metadata outcome of `"consequential"`.
 */
export const EXTERNAL_TAG = "effect:external";
/**
 * The call can't be undone, such as deleting a repository. It counts as external too. MCP:
 * `destructiveHint: true`, or an action-metadata outcome of `"irreversible"`.
 */
export const IRREVERSIBLE_TAG = "effect:irreversible";
/** The call can put data somewhere publicly accessible. SEP-2061 destination `Public`. */
export const PUBLIC_SINK_TAG = "sink:public";

/**
 * Built-in tools that can read text from outside the trust boundary. Built-ins carry no tags.
 * `agent` runs a copy of this agent with the same tools, so its result can carry what they read.
 */
export const UNTRUSTED_BUILT_INS: readonly string[] = ["agent", "bash", "web_fetch", "web_search"];

/** Most sources an exposure keeps. The newest win. */
export const MAX_SOURCES = 20;

/** Source recorded for a message from someone other than the session's initiator. */
export const MESSAGE_SOURCE = "message";

/** Whether this session's model has read untrusted content, and where it came from. */
export interface Exposure {
  readonly exposed: boolean;
  /** Tool names, or `"message"`, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sources: readonly string[];
  /** Untrusted calls requested but not settled yet, by call id, with their tool names. */
  readonly pending: Readonly<Record<string, string>>;
}

export function initialExposure(): Exposure {
  return { exposed: false, pending: {}, sources: [] };
}

/** Whether a call's result can carry untrusted content. An entry's own tags beat its name. */
export function readsUntrusted(capability: {
  readonly name: string;
  readonly tags?: readonly string[];
}): boolean {
  if (capability.tags !== undefined) return capability.tags.includes(UNTRUSTED_TAG);
  return UNTRUSTED_BUILT_INS.includes(capability.name);
}

/** Marks the session exposed by `source`. */
export function expose(state: Exposure, source: string): Exposure {
  const sources = [...state.sources.filter((existing) => existing !== source), source];
  return { ...state, exposed: true, sources: sources.slice(-MAX_SOURCES) };
}

export function requested(state: Exposure, callId: string, name: string): Exposure {
  return { ...state, pending: { ...state.pending, [callId]: name } };
}

/**
 * Settles a pending untrusted call. The model reads its result unless the call was rejected
 * before it ran, so every other outcome exposes the session: a failed or interrupted call can
 * still return text it read.
 */
export function settled(state: Exposure, callId: string, outcome: string): Exposure {
  const name = state.pending[callId];
  if (name === undefined) return state;
  const { [callId]: _, ...pending } = state.pending;
  const next = { ...state, pending };
  return outcome === "rejected" ? next : expose(next, name);
}

/** Options for {@link decide} and `taintPolicy()`. */
export interface TaintPolicyOptions {
  /**
   * What an exposed session gets for a call tagged both `effect:irreversible` and `sink:public`,
   * which puts data somewhere public for good. Default `"deny"`.
   */
  readonly onPublish?: "deny" | "user-approval";
  /**
   * How an exposed session treats a connection tool with no tags. `"treat-as-external"` counts it
   * as external unless the server marks it `readOnlyHint: true`, and as irreversible when the
   * server marks it `destructiveHint: true`. Default `"ignore"`.
   */
  readonly untaggedConnections?: "ignore" | "treat-as-external";
  /**
   * Also mark the session exposed when an untrusted call is requested, from the policy, instead
   * of only once it settles. The mark lands in the same step as the request, so an interrupted
   * hook can't lose it, but a call that is then denied or fails validation still exposes the
   * session. Default `false`.
   */
  readonly markOnRequest?: boolean;
  /**
   * Gate external calls only when this also holds for the call, such as `exceedsCap` from
   * `eve/extensions/private-context` for the Rule of Two. Irreversible calls are gated whatever
   * it returns. Default: every call.
   */
  readonly when?: (ctx: ApprovalContext) => boolean | Promise<boolean>;
}

/** The parts of an approval context the decision reads. */
export interface DecisionInput {
  readonly toolName: string;
  readonly toolTags?: readonly string[];
  readonly toolAnnotations?: ConnectionToolAnnotations;
}

/**
 * The approval status for one call, given the session's exposure. `gated` is what the `when`
 * option returned for the call; an irreversible call asks either way.
 */
export function decide(
  exposure: Exposure,
  call: DecisionInput,
  options: Omit<TaintPolicyOptions, "when"> = {},
  gated = true,
): ApprovalStatus {
  if (!exposure.exposed) return undefined;
  const effect = effectOf(call, options);
  if (effect === undefined) return undefined;
  if (effect === "irreversible" && call.toolTags?.includes(PUBLIC_SINK_TAG) === true && gated) {
    if (options.onPublish === "user-approval") return "user-approval";
    return { reason: deniedReason(call.toolName, exposure.sources), type: "denied" };
  }
  return effect === "irreversible" || gated ? "user-approval" : undefined;
}

/** What the call does outside the session, from its tags or, untagged, its server's hints. */
function effectOf(
  call: DecisionInput,
  options: Omit<TaintPolicyOptions, "when">,
): "external" | "irreversible" | undefined {
  const tags = call.toolTags;
  if (tags !== undefined) {
    if (tags.includes(IRREVERSIBLE_TAG)) return "irreversible";
    return tags.includes(EXTERNAL_TAG) ? "external" : undefined;
  }
  if (options.untaggedConnections !== "treat-as-external" || !isConnectionTool(call)) {
    return undefined;
  }
  if (call.toolAnnotations?.destructiveHint === true) return "irreversible";
  return call.toolAnnotations?.readOnlyHint === true ? undefined : "external";
}

/**
 * Connection tools are the ones a server describes, or are named `<connection>__<tool>`. The name
 * also matches mounted extension tools, which errs toward asking.
 */
function isConnectionTool(call: DecisionInput): boolean {
  if (call.toolAnnotations !== undefined) return true;
  return call.toolName.includes("__") && !call.toolName.startsWith("eve__");
}

function deniedReason(toolName: string, sources: readonly string[]): string {
  return `This session read untrusted content from ${sources.join(", ")}, so \`${toolName}\` can't publish data. Finish without publishing, or ask the user to publish it themselves.`;
}

/** Most characters of the comma-joined sources a span attribute carries. */
export const MAX_SOURCES_ATTRIBUTE_LENGTH = 256;

/** Span attributes for the session's exposure. */
export function runtimeContextOf(exposure: Exposure): {
  readonly "taint.exposed": boolean;
  readonly "taint.sources": string;
} {
  const sources = exposure.sources.join(",");
  return {
    "taint.exposed": exposure.exposed,
    "taint.sources":
      sources.length > MAX_SOURCES_ATTRIBUTE_LENGTH
        ? `${sources.slice(0, MAX_SOURCES_ATTRIBUTE_LENGTH - 1)}…`
        : sources,
  };
}
