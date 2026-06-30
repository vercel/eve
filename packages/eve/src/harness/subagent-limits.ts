import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessSession, HarnessToolMap, SessionStateMap } from "#harness/types.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import type { AgentSubagentLimitsDefinition } from "#shared/agent-definition.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 4;

const SUBAGENT_LIMIT_STATE_KEY = "eve.runtime.subagentLimits";

interface SubagentLimitState {
  readonly depth?: number;
  readonly maxDepth?: number;
}

type DelegationAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentLimitRejection {
  readonly action: DelegationAction;
  readonly message: string;
}

export interface ApplySubagentLimitsResult {
  readonly actions: readonly RuntimeActionRequest[];
  readonly rejectedResults: readonly RuntimeSubagentResultActionResult[];
  readonly session: HarnessSession;
}

export interface EffectiveSubagentLimits {
  readonly maxDepth: number;
}

export function filterAdvertisedSubagentTools(input: {
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): HarnessToolMap {
  const depth = getSubagentDepth(input.session.state);
  const limits = getEffectiveSubagentLimits(input.session.state);

  if (depth < limits.maxDepth) {
    return input.tools;
  }

  const tools = new Map(input.tools);

  for (const [name, definition] of input.tools) {
    if (isSubagentRuntimeAction(definition)) {
      tools.delete(name);
    }
  }

  return tools;
}

export function applySubagentLimits(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly session: HarnessSession;
  readonly step?: {
    readonly stepIndex: number;
    readonly turnId: string;
  };
}): ApplySubagentLimitsResult {
  const depth = getSubagentDepth(input.session.state);
  const limits = getEffectiveSubagentLimits(input.session.state);

  if (depth < limits.maxDepth) {
    return {
      actions: input.actions,
      rejectedResults: [],
      session: input.session,
    };
  }

  const actions: RuntimeActionRequest[] = [];
  const rejections: SubagentLimitRejection[] = [];

  for (const action of input.actions) {
    if (!isDelegationAction(action)) {
      actions.push(action);
      continue;
    }

    rejections.push({
      action,
      message:
        "Maximum subagent depth reached. Do not retry this subagent call; complete the work in this session or return a partial result.",
    });
  }

  return {
    actions,
    rejectedResults: rejections.map(createSubagentLimitResult),
    session: input.session,
  };
}

export function getChildSubagentDepth(session: HarnessSession): number {
  return getSubagentDepth(session.state) + 1;
}

export function resolveEffectiveSubagentLimits(input: {
  readonly authored?: AgentSubagentLimitsDefinition;
  readonly inherited?: AgentSubagentLimitsDefinition;
}): EffectiveSubagentLimits {
  if (input.inherited === undefined) {
    return {
      maxDepth: normalizePositiveInteger(input.authored?.maxDepth) ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    };
  }

  const inherited = normalizeEffectiveSubagentLimits(input.inherited);
  return {
    maxDepth:
      input.authored?.maxDepth === undefined
        ? inherited.maxDepth
        : Math.min(inherited.maxDepth, input.authored.maxDepth),
  };
}

export function getEffectiveSubagentLimits(
  state: SessionStateMap | undefined,
): EffectiveSubagentLimits {
  const value = state?.[SUBAGENT_LIMIT_STATE_KEY];
  if (typeof value !== "object" || value === null) return DEFAULT_SUBAGENT_LIMITS;
  return normalizeEffectiveSubagentLimits(value as AgentSubagentLimitsDefinition);
}

export function setSubagentLimitState(input: {
  readonly depth: number | undefined;
  readonly limits: EffectiveSubagentLimits;
  readonly session: HarnessSession;
}): HarnessSession {
  const depth = normalizeDepth(input.depth);
  if (depth === 0 && isDefaultSubagentLimits(input.limits)) return input.session;

  const state = { ...input.session.state };
  state[SUBAGENT_LIMIT_STATE_KEY] = {
    depth: depth === 0 ? undefined : depth,
    maxDepth: input.limits.maxDepth,
  } satisfies SubagentLimitState;
  return { ...input.session, state };
}

export function setSubagentDepth(input: {
  readonly depth: number | undefined;
  readonly session: HarnessSession;
}): HarnessSession {
  const depth = normalizeDepth(input.depth);
  if (depth === 0) return input.session;

  const limits = getEffectiveSubagentLimits(input.session.state);
  const state = { ...input.session.state };
  state[SUBAGENT_LIMIT_STATE_KEY] = {
    depth,
    maxDepth: limits.maxDepth,
  } satisfies SubagentLimitState;
  return { ...input.session, state };
}

export function getSubagentDepth(state: SessionStateMap | undefined): number {
  const value = state?.[SUBAGENT_LIMIT_STATE_KEY];
  if (typeof value !== "object" || value === null) return 0;
  return normalizeDepth((value as SubagentLimitState).depth);
}

function createSubagentLimitResult(
  rejection: SubagentLimitRejection,
): RuntimeSubagentResultActionResult {
  return {
    callId: rejection.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "EVE_SUBAGENT_DEPTH_LIMIT_EXCEEDED",
      message: rejection.message,
    },
    subagentName: getDelegationActionName(rejection.action),
  };
}

function getDelegationActionName(action: DelegationAction): string {
  return action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
}

function isDelegationAction(action: RuntimeActionRequest): action is DelegationAction {
  return action.kind === "remote-agent-call" || action.kind === "subagent-call";
}

function isSubagentRuntimeAction(definition: HarnessToolDefinition): boolean {
  return (
    definition.runtimeAction?.kind === "remote-agent-call" ||
    definition.runtimeAction?.kind === "subagent-call"
  );
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isInteger(depth) || depth < 0) return 0;
  return depth;
}

const DEFAULT_SUBAGENT_LIMITS: EffectiveSubagentLimits = {
  maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
};

function normalizeEffectiveSubagentLimits(
  limits: AgentSubagentLimitsDefinition,
): EffectiveSubagentLimits {
  return {
    maxDepth: normalizePositiveInteger(limits.maxDepth) ?? DEFAULT_MAX_SUBAGENT_DEPTH,
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? undefined : value;
}

function isDefaultSubagentLimits(limits: EffectiveSubagentLimits): boolean {
  return limits.maxDepth === DEFAULT_MAX_SUBAGENT_DEPTH;
}
