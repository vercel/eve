import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type {
  SessionAgent,
  SessionAgentReference,
  SessionAgentSettings,
} from "#runtime/sessions/session-agent.js";
import { agentDefinitionsOf, type AgentContents } from "./agent-definitions.js";
import type { Definition } from "./definition.js";

// The one implementation of the session-agent port. What produces an agent (a compiled bundle,
// `#definitions/compiled-agent.js`) says where each of its parts comes from; this reads each on
// first use, once, and builds its definitions from its contents with `agentDefinitionsOf`.

/** Where each part of an agent comes from. Thunks are read on first use, once. */
export interface SessionAgentInput {
  /** Who it is, as events and traces name it: each read when asked, apart from the others. */
  readonly id: () => string;
  readonly name?: () => string | undefined;
  readonly nodeId?: () => string | undefined;
  /** How a step boundary carries it; read apart from its identity, only when a boundary asks. */
  readonly reference: () => SessionAgentReference;
  /** Its contents, as `agentDefinitionsOf` takes them; read on the first `definitions()`. */
  readonly contents: () => Promise<AgentContents>;
  readonly settings: () => SessionAgentSettings;
  readonly revision: SessionAgent["revision"];
  readonly adapters: RuntimeAdapterRegistry;
  readonly delegates: SessionAgent["delegates"];
  readonly roster: SessionAgent["roster"];
  readonly sandbox: SessionAgent["sandbox"];
  readonly connections: SessionAgent["connections"];
  /** The compiled node, for an agent compiled from files. */
  readonly compiled?: CompiledRuntimeAgentBundle;
}

/** The session agent `input` describes. */
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
        // A failed build is tried again by the next caller.
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
