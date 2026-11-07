import { sha256Base64Url } from "#shared/digest.js";
import type { Definition } from "#definitions/definition.js";
import {
  createRuntimeAdapterRegistry,
  type RuntimeAdapterRegistry,
} from "#runtime/channels/registry.js";
import type { AgentRoster } from "#execution/agent-sessions/roster.js";
import { NonRetryableError } from "#shared/run-errors.js";
import type { SessionAgent, SessionAgentSettings } from "./session-agent.js";

// An agent defined in code: the port's implementation from definitions a program holds, with
// no compiled artifacts behind it. A step boundary carries it by its id, so its sessions run in
// the process that holds it (`holdSessionAgent`). Its sandbox is the one the first definition
// naming one provides (`resources.sandbox`).

/** A program's agent: its definitions, and what it sets. */
export interface CodeAgentInput {
  readonly id: string;
  readonly name?: string;
  readonly definitions: readonly Definition[];
  readonly settings?: SessionAgentSettings;
  /**
   * The host's version of the agent's code. The revision digests the definitions' ids, which
   * don't change when a tool's code does, so a host that changes code under the same ids bumps it.
   */
  readonly version?: string;
  /** The channel adapters its sessions' channels rehydrate from; none by default. */
  readonly adapters?: RuntimeAdapterRegistry;
}

/** An agent built from `input`'s definitions. */
export function createSessionAgent(input: CodeAgentInput): SessionAgent {
  const definitions = [...input.definitions];
  const revision = codeAgentRevision(input.id, definitions, input.version);
  const sandbox = sandboxDefinitionOf(definitions)?.resources?.sandbox;
  return {
    adapters: input.adapters ?? createRuntimeAdapterRegistry({ channels: [] }),
    // A connection definition installs its connections into the session's registry.
    connections: () => [],
    definitions: async () => definitions,
    // It delegates to no agent: a workflow tool's `ctx.agents` is empty.
    delegates: () => ({}),
    id: input.id,
    name: input.name,
    reference: { id: input.id, kind: "runtime" },
    roster: () => noSubagents,
    revision: async () => revision,
    // It owns its sandbox: a code agent's sessions never borrow a parent's.
    sandbox: async () =>
      sandbox === undefined
        ? undefined
        : {
            registry: sandbox.registry,
            sharesParent: false,
            template: { appRoot: sandbox.appRoot, preparedArtifact: sandbox.preparedArtifact },
          },
    settings: input.settings ?? {},
  };
}

/** The definition whose sandbox the agent's sessions open: the first that declares one. */
export function sandboxDefinitionOf(definitions: readonly Definition[]): Definition | undefined {
  return definitions.find((definition) => definition.resources?.sandbox !== undefined);
}

/** A digest of the agent's id, its definitions' sorted ids, and the host's version. */
export function codeAgentRevision(
  id: string,
  definitions: readonly Pick<Definition, "id">[],
  version?: string,
): string {
  const ids = definitions.map((definition) => definition.id).sort();
  const digest = sha256Base64Url(JSON.stringify({ id, ids, version: version ?? null }));
  return `agent:${digest.slice(0, 22)}`;
}

/** It opens no agent: `ctx.agent()` and the agent tool name none it can reach. */
const noSubagents: AgentRoster = {
  childRuntime: (target) => unavailable(target.action.name),
  resolveAction: (_callId, input) => unavailable(input.target),
  runtimeOverrides: async (name) => unavailable(name),
  startTarget: (action) => unavailable(action.name),
};

function unavailable(name: string): never {
  throw new NonRetryableError(`Agent target "${name}" is not available to this agent.`);
}
