import { SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type {
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
  extra?: { readonly inputRequest?: EveMessageInputRequest },
): EveMessageToolMetadata {
  return {
    eve: {
      inputRequest: extra?.inputRequest,
      kind: descriptor.kind,
      name: descriptor.name,
    },
  };
}

/**
 * Merges freshly derived tool metadata over any metadata already attached to a
 * tool part, preferring the new values while preserving earlier request and
 * response context.
 */
export function mergeToolMetadata(
  current: EveMessageToolMetadata | undefined,
  next: EveMessageToolMetadata,
): EveMessageToolMetadata {
  const kind = next.eve?.kind ?? current?.eve?.kind ?? "unknown";
  const name = next.eve?.name ?? current?.eve?.name ?? "unknown";

  return {
    eve: {
      ...current?.eve,
      ...next.eve,
      inputRequest: next.eve?.inputRequest ?? current?.eve?.inputRequest,
      inputResponse: next.eve?.inputResponse ?? current?.eve?.inputResponse,
      kind,
      name,
    },
  };
}

/** Maps a runtime action request onto its normalized tool descriptor. */
export function normalizeActionRequest(action: RuntimeActionRequest): ActionDescriptor {
  const name = actionRequestName(action);
  switch (action.kind) {
    case "load-skill":
      return { kind: "load-skill", name, toolName: SKILL_ENTRY_NAME };
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
        name: result.name ?? SKILL_ENTRY_NAME,
        toolName: SKILL_ENTRY_NAME,
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
