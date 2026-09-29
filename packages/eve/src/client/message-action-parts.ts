import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type {
  EveDynamicToolPart,
  EveMessageInputRequest,
  EveMessageToolMetadata,
} from "#client/message-reducer-types.js";

/**
 * Normalized tool descriptor derived from a runtime action request or result.
 *
 * The default message reducer projects load-skill, subagent, remote-agent, and
 * plain tool calls onto a single `dynamic-tool` UI part; this descriptor is the
 * shared shape those variants collapse to before rendering.
 */
interface ActionDescriptor {
  readonly kind: "load-skill" | "subagent-call" | "tool-call";
  readonly name: string;
  readonly toolName: string;
}

/** Projects a runtime input request onto its UI-facing subset. */
export function toMessageInputRequest(request: InputRequest): EveMessageInputRequest {
  return {
    allowFreeform: request.allowFreeform,
    display: request.display,
    kind: request.kind,
    options: request.options,
    prompt: request.prompt,
    requestId: request.requestId,
  };
}

/** Builds tool metadata for a freshly projected tool part. */
export function createToolMetadata(
  descriptor: ActionDescriptor,
  extra?: { readonly inputRequest?: EveMessageInputRequest; readonly taskId?: string },
): EveMessageToolMetadata {
  return {
    eve: {
      inputRequest: extra?.inputRequest,
      kind: descriptor.kind,
      name: descriptor.name,
      ...(extra?.taskId !== undefined && { taskId: extra.taskId }),
    },
  };
}

/**
 * Applies a metadata patch to a tool part's existing metadata. Fields the patch leaves out keep
 * their current values, and `kind` and `name` fall back to the current values, then the part's
 * tool name.
 */
export function mergeToolMetadata(
  existing: EveDynamicToolPart | undefined,
  patch: Partial<NonNullable<EveMessageToolMetadata["eve"]>>,
): EveMessageToolMetadata {
  const current = existing?.toolMetadata?.eve;
  const defined: typeof patch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  return {
    eve: {
      ...current,
      ...defined,
      kind: defined.kind ?? current?.kind ?? "unknown",
      name: defined.name ?? current?.name ?? existing?.toolName ?? "unknown",
    },
  };
}

/**
 * Derives the approved-approval descriptor a resolved tool result carries
 * forward, or `undefined` when the tool part never had an approval.
 */
export function approvedApproval(part: EveDynamicToolPart | undefined):
  | {
      readonly id: string;
      readonly approved: true;
      readonly reason?: string;
      readonly isAutomatic?: boolean;
    }
  | undefined {
  if (!part?.approval?.id) {
    return undefined;
  }
  return {
    approved: true,
    id: part.approval.id,
    isAutomatic: part.approval.isAutomatic,
    reason: part.approval.reason,
  };
}

/** Maps a runtime action request onto its normalized tool descriptor. */
export function normalizeActionRequest(action: RuntimeActionRequest): ActionDescriptor {
  const name = actionRequestName(action);
  switch (action.kind) {
    case "load-skill":
      return { kind: "load-skill", name, toolName: "eve:load-skill" };
    case "tool-call":
    case "workflow-tool-call":
      return { kind: "tool-call", name, toolName: name };
    case "subagent-call":
    case "remote-agent-call":
      return { kind: "subagent-call", name, toolName: `eve:subagent:${name}` };
  }
}

/** Maps a runtime action result onto its normalized tool descriptor. */
export function normalizeActionResult(result: RuntimeActionResult): ActionDescriptor {
  switch (result.kind) {
    case "load-skill-result":
      return {
        kind: "load-skill",
        name: result.name ?? "load_skill",
        toolName: "eve:load-skill",
      };
    case "tool-result":
      return {
        kind: "tool-call",
        name: result.toolName,
        toolName: result.toolName,
      };
    case "subagent-result":
      return {
        kind: "subagent-call",
        name: result.subagentName,
        toolName: `eve:subagent:${result.subagentName}`,
      };
  }
}

/** Best-effort string rendering of an unknown tool output for error display. */
export function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Action failed.";
  }
}
