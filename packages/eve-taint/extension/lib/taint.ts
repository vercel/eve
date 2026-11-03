import type { ApprovalStatus, ConnectionToolAnnotations } from "eve/tools/approval";

/** The result can contain text someone outside the trust boundary wrote. */
export const UNTRUSTED_TAG = "reads:untrusted";
/** The result can contain private or sensitive data. */
export const SENSITIVE_TAG = "reads:sensitive";
/** The result can contain the caller's private data. Counts as {@link SENSITIVE_TAG}. */
export const PERSONAL_TAG = "reads:personal";
/** The call acts on a sensitive system, such as production or billing. */
export const SENSITIVE_EFFECT_TAG = "effect:sensitive";
/** The call changes state or sends data outside the session. */
export const EXTERNAL_TAG = "effect:external";
/** The call moves data somewhere bulk or persistent: an export, an upload, a share. */
export const EXPORT_TAG = "effect:export";

/**
 * Built-in tools that can read text from outside the trust boundary. Built-ins carry no tags.
 * `agent` runs a copy of this agent with the same tools, so its result can carry what they read.
 */
export const UNTRUSTED_BUILT_INS: readonly string[] = ["agent", "bash", "web_fetch", "web_search"];

/** Built-in tools that can read sensitive data: `agent`, for the same reason. */
export const SENSITIVE_BUILT_INS: readonly string[] = ["agent"];

/** Most sources each leg keeps. The newest win. */
export const MAX_SOURCES = 20;

/** Source recorded for a message from someone other than the session's initiator. */
export const MESSAGE_SOURCE = "message";

/** A leg of the Rule of Two that a session's reads can put in place. */
export type ReadLeg = "untrusted" | "sensitive";

/** Which legs of the Rule of Two this session's model has read, and where they came from. */
export interface Exposure {
  /** The session read untrusted content. */
  readonly exposed: boolean;
  /** Tool names, or `"message"`, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sources: readonly string[];
  /** The session read sensitive data. */
  readonly sensitive: boolean;
  /** Tool names, deduplicated, newest last, at most {@link MAX_SOURCES}. */
  readonly sensitiveSources: readonly string[];
  /** Reads requested but not settled yet, by call id, with their tool names and legs. */
  readonly pending: Readonly<
    Record<string, { readonly name: string; readonly reads: readonly ReadLeg[] }>
  >;
}

export function initialExposure(): Exposure {
  return { exposed: false, pending: {}, sensitive: false, sensitiveSources: [], sources: [] };
}

/** The legs a call's result can put in place. An entry's own tags beat its name. */
export function readsOf(capability: {
  readonly name: string;
  readonly tags?: readonly string[];
}): readonly ReadLeg[] {
  const { name, tags } = capability;
  const untrusted =
    tags === undefined ? UNTRUSTED_BUILT_INS.includes(name) : tags.includes(UNTRUSTED_TAG);
  const sensitive =
    tags === undefined
      ? SENSITIVE_BUILT_INS.includes(name)
      : tags.includes(SENSITIVE_TAG) || tags.includes(PERSONAL_TAG);
  return [
    ...(untrusted ? ["untrusted" as const] : []),
    ...(sensitive ? ["sensitive" as const] : []),
  ];
}

/** Puts `leg` in place, from `source`. */
export function expose(state: Exposure, leg: ReadLeg, source: string): Exposure {
  const add = (sources: readonly string[]) =>
    [...sources.filter((existing) => existing !== source), source].slice(-MAX_SOURCES);
  return leg === "untrusted"
    ? { ...state, exposed: true, sources: add(state.sources) }
    : { ...state, sensitive: true, sensitiveSources: add(state.sensitiveSources) };
}

export function requested(
  state: Exposure,
  callId: string,
  name: string,
  reads: readonly ReadLeg[],
): Exposure {
  return { ...state, pending: { ...state.pending, [callId]: { name, reads } } };
}

/**
 * Settles a pending read. The model reads its result unless the call was rejected before it ran,
 * so every other outcome counts: a failed or interrupted call can still return what it read.
 */
export function settled(state: Exposure, callId: string, outcome: string): Exposure {
  const read = state.pending[callId];
  if (read === undefined) return state;
  const { [callId]: _, ...pending } = state.pending;
  const next = { ...state, pending };
  if (outcome === "rejected") return next;
  return read.reads.reduce((current, leg) => expose(current, leg, read.name), next);
}

/** Options for {@link decide} and `taintPolicy()`. */
export interface TaintPolicyOptions {
  /** Tag that marks an export. Default `"effect:export"`. */
  readonly exportTag?: string;
  /** Tag that marks an external effect. Default `"effect:external"`. */
  readonly externalTag?: string;
  /** What a call that completes the Rule of Two gets when it's an export. Default `"deny"`. */
  readonly onExport?: "deny" | "user-approval";
  /**
   * How the policy treats a connection tool with no tags. `"treat-as-external"` counts it as an
   * external effect unless the server marks the tool `readOnlyHint: true`. Default `"ignore"`.
   */
  readonly untaggedConnections?: "ignore" | "treat-as-external";
  /**
   * Treat every session as holding sensitive data, so untrusted content alone gates external
   * effects. Default `false`.
   */
  readonly assumeSensitive?: boolean;
  /**
   * Also record a read when it's requested, from the policy, instead of only once it settles. The
   * mark lands in the same step as the request, so an interrupted hook can't lose it, but a call
   * that is then denied or fails validation still counts. Default `false`.
   */
  readonly markOnRequest?: boolean;
}

/** The parts of an approval context the decision reads. */
export interface DecisionInput {
  readonly toolName: string;
  readonly toolTags?: readonly string[];
  readonly toolAnnotations?: ConnectionToolAnnotations;
}

/**
 * The approval status for one call under the Rule of Two: a call needs a person only when the
 * session has read untrusted content, holds sensitive data or the call acts on a sensitive
 * system, and the call is an external effect.
 */
export function decide(
  exposure: Exposure,
  call: DecisionInput,
  options: TaintPolicyOptions = {},
): ApprovalStatus {
  const tags = call.toolTags;
  if (!exposure.exposed) return undefined;
  const sensitiveSystem = tags?.includes(SENSITIVE_EFFECT_TAG) === true;
  if (!exposure.sensitive && !sensitiveSystem && options.assumeSensitive !== true) {
    return undefined;
  }
  if (tags?.includes(options.exportTag ?? EXPORT_TAG)) {
    if (options.onExport === "user-approval") return "user-approval";
    return { reason: deniedReason(call.toolName, exposure, sensitiveSystem), type: "denied" };
  }
  if (tags?.includes(options.externalTag ?? EXTERNAL_TAG)) return "user-approval";
  if (
    tags === undefined &&
    options.untaggedConnections === "treat-as-external" &&
    isConnectionTool(call) &&
    call.toolAnnotations?.readOnlyHint !== true
  ) {
    return "user-approval";
  }
  return undefined;
}

/**
 * Connection tools are the ones a server describes, or are named `<connection>__<tool>`. The name
 * also matches mounted extension tools, which errs toward asking.
 */
function isConnectionTool(call: DecisionInput): boolean {
  if (call.toolAnnotations !== undefined) return true;
  return call.toolName.includes("__") && !call.toolName.startsWith("eve__");
}

function deniedReason(toolName: string, exposure: Exposure, sensitiveSystem: boolean): string {
  const sensitive =
    exposure.sensitiveSources.length > 0
      ? ` and sensitive data from ${exposure.sensitiveSources.join(", ")}`
      : sensitiveSystem
        ? `, and \`${toolName}\` acts on a sensitive system`
        : "";
  return `This session read untrusted content from ${exposure.sources.join(", ")}${sensitive}, so \`${toolName}\` can't export data. Finish without exporting, or ask the user to export it themselves.`;
}

/** Most characters of a comma-joined sources span attribute. */
export const MAX_SOURCES_ATTRIBUTE_LENGTH = 256;

/** Span attributes for the session's exposure. */
export function runtimeContextOf(exposure: Exposure): {
  readonly "taint.exposed": boolean;
  readonly "taint.sources": string;
  readonly "taint.sensitive": boolean;
  readonly "taint.sensitive_sources": string;
} {
  return {
    "taint.exposed": exposure.exposed,
    "taint.sources": joined(exposure.sources),
    "taint.sensitive": exposure.sensitive,
    "taint.sensitive_sources": joined(exposure.sensitiveSources),
  };
}

function joined(sources: readonly string[]): string {
  const value = sources.join(",");
  return value.length > MAX_SOURCES_ATTRIBUTE_LENGTH
    ? `${value.slice(0, MAX_SOURCES_ATTRIBUTE_LENGTH - 1)}…`
    : value;
}
