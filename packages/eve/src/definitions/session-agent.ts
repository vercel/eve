import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type {
  SessionAgent,
  SessionAgentReference,
  SessionAgentSettings,
} from "#runtime/sessions/session-agent.js";
import { agentDefinitionsOf, type AgentContents } from "./agent-definitions.js";
import type { Definition } from "./definition.js";

export interface SessionAgentInput {
  readonly id: () => string;
  readonly name?: () => string | undefined;
  readonly nodeId?: () => string | undefined;
  readonly reference: () => SessionAgentReference;
  readonly contents: () => Promise<AgentContents>;
  readonly settings: () => SessionAgentSettings;
  readonly revision: SessionAgent["revision"];
  readonly adapters: RuntimeAdapterRegistry;
  readonly delegates: SessionAgent["delegates"];
  readonly roster: SessionAgent["roster"];
  readonly sandbox: SessionAgent["sandbox"];
  readonly connections: SessionAgent["connections"];
  readonly compiled?: CompiledRuntimeAgentBundle;
}

export function createSessionAgent(input: SessionAgentInput): SessionAgent {
  let reference: SessionAgentReference | undefined;
  let settings: SessionAgentSettings | undefined;
  let definitions: Promise<readonly Definition[]> | undefined;
  return {
    adapters: input.adapters,
    ...(input.compiled !== undefined && { compiled: input.compiled }),
    connections: input.connections,
    definitions: () => {
      if (definitions === undefined) {
        const building = input.contents().then(agentDefinitionsOf);
        definitions = building;
        building.catch(() => {
          if (definitions === building) definitions = undefined;
        });
      }
      return definitions;
    },
    delegates: input.delegates,
    roster: input.roster,
    revision: input.revision,
    sandbox: input.sandbox,
    get id() {
      return input.id();
    },
    get name() {
      return input.name?.();
    },
    get nodeId() {
      return input.nodeId?.();
    },
    get reference() {
      return (reference ??= input.reference());
    },
    get settings() {
      return (settings ??= input.settings());
    },
  };
}
