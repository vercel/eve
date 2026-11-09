import { sha256Base64Url } from "#shared/digest.js";
import { ParentSessionKey } from "#context/keys.js";
import type { Definition } from "#definitions/definition.js";
import { subagentNodeId } from "#definitions/delegation.js";
import { codeAgentDelegates, codeAgentRoster } from "#execution/agent-sessions/code-roster.js";
import {
  createRuntimeAdapterRegistry,
  type RuntimeAdapterRegistry,
} from "#runtime/channels/registry.js";
import type { CodeAgent, SessionAgentSettings, SessionSubagent } from "./session-agent.js";

// An agent defined in code: the port's implementation from definitions a program holds, with
// no compiled artifacts behind it. A step boundary carries it by its id, so its sessions run in
// the process that holds it (`holdSessionAgent`). Its sandbox is the one the first definition
// naming one provides (`resources.sandbox`); its subagents are what its definitions declare
// (`resources.subagent`), each under an id scoped by its own.

/** A program's agent: its definitions, and what it sets. */
export interface CodeAgentInput {
  readonly id: string;
  readonly name?: string;
  /** What it's for, which a parent's model reads when the agent is its subagent. */
  readonly description?: string;
  /** Its node when it's a subagent (`subagents/<name>`); a root agent has none. */
  readonly nodeId?: string;
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
export function createSessionAgent(input: CodeAgentInput): CodeAgent {
  const definitions = [...input.definitions];
  const revision = codeAgentRevision(input.id, definitions, input.version);
  const sandbox = sandboxDefinitionOf(definitions)?.resources?.sandbox;
  const subagents = declaredSubagents(input.id, definitions);
  const agent: CodeAgent = {
    adapters: input.adapters ?? createRuntimeAdapterRegistry({ channels: [] }),
    // A connection definition installs its connections into the session's registry.
    connections: () => [],
    definitions: async () => definitions,
    delegates: (ctx) => codeAgentDelegates(agent, ctx.get(ParentSessionKey) === undefined),
    description: input.description,
    id: input.id,
    name: input.name,
    nodeId: input.nodeId,
    reference: { id: input.id, kind: "runtime" },
    revision: async () => revision,
    roster: () => codeAgentRoster(agent),
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
    subagents,
    with: (identity) => createSessionAgent({ ...input, ...identity }),
  };
  return agent;
}

/** The subagents `definitions` declare, each under `<parentId>/<name>` and its own node. */
function declaredSubagents(
  parentId: string,
  definitions: readonly Definition[],
): ReadonlyMap<string, SessionSubagent> {
  const subagents = new Map<string, SessionSubagent>();
  for (const definition of definitions) {
    const declared = definition.resources?.subagent;
    if (declared === undefined) continue;
    if (subagents.has(declared.name)) {
      throw new Error(`Agent "${parentId}" declares the subagent "${declared.name}" twice.`);
    }
    subagents.set(declared.name, {
      ...declared,
      agent: declared.agent.with({
        id: `${parentId}/${declared.name}`,
        nodeId: subagentNodeId(declared.name),
      }),
    });
  }
  return subagents;
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
