import { isPrivateOrReservedIpAddress } from "#shared/network-address.js";
import { createHash } from "node:crypto";
import type { ContextReader } from "#context/key.js";
import type { HarnessSession } from "#harness/types.js";
import { ParentSessionKey } from "#context/keys.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  getAgentRegistryState,
  setAgentRegistryState,
  assertPersistableAgentRegistryState,
  EMPTY_AGENT_REGISTRY_STATE,
  type AgentRegistryState,
  type AgentRegistryCommand,
  type AgentRegistryCommandResult,
  type AgentRegistryEntry,
} from "#subagents/registry/state.js";
import { applyAgentRegistryCommand } from "#subagents/registry/transitions.js";
import type { AgentDestination, AgentReference } from "#subagents/registration.js";

export { AgentRegistryKey } from "#context/agent-registry-key.js";

/** Owns the step's destination registrations and invocation transitions. */
export class AgentRegistry {
  #state: AgentRegistryState;
  #changed = false;
  readonly #sessionId: string;
  readonly #ctx: ContextReader;

  constructor(ctx: ContextReader, session: HarnessSession) {
    this.#ctx = ctx;
    this.#sessionId = session.sessionId;
    this.#state = getAgentRegistryState(session.state) ?? EMPTY_AGENT_REGISTRY_STATE;
  }

  get entries(): readonly AgentRegistryEntry[] {
    return this.#state.handles;
  }

  /** Uses the same reducer as commands delivered through the durable inbox. */
  dispatch(command: AgentRegistryCommand): AgentRegistryCommandResult {
    const applied = applyAgentRegistryCommand(this.#state, command);
    if (applied.store !== this.#state) this.#write(applied.store);
    return applied.result;
  }

  #write(state: AgentRegistryState): void {
    this.#state = assertPersistableAgentRegistryState(state);
    this.#changed = true;
  }

  commit(session: HarnessSession): HarnessSession {
    if (!this.#changed) return session;
    return { ...session, state: setAgentRegistryState(session.state, this.#state) };
  }

  initialize(): void {
    if (this.#state.registrationsInitialized) return;
    const bundle = this.#ctx.get(BundleKey);
    if (!bundle) return;
    for (const [name, entry] of bundle.subagentRegistry.subagentsByName ?? []) {
      this.register({
        key: name,
        description: entry.definition.description ?? name,
        target: { kind: "agent", name },
      });
    }
    this.#write({ ...this.#state, registrationsInitialized: true });
  }

  register(destination: AgentDestination): AgentReference {
    const existing = this.entries.find(
      (handle) =>
        handle.identity.registration?.visible &&
        handle.identity.registration.key === destination.key,
    );
    if (existing) {
      const { visible: _visible, ...current } = existing.identity.registration!;
      if (
        current.key !== destination.key ||
        current.description !== destination.description ||
        !sameTarget(current.target, destination.target)
      )
        throw new Error(
          `Agent destination "${destination.key}" is already registered with different content.`,
        );
      return { id: existing.identity.id };
    }
    if (
      this.entries.filter((handle) => handle.identity.registration?.visible === true).length >= 128
    )
      throw new Error("A session can register at most 128 agent destinations.");
    const bundle = this.#ctx.require(BundleKey);
    const target = destination.target;
    const definition =
      target.kind === "agent"
        ? (bundle.subagentRegistry.subagentsByName.get(target.name)?.definition ??
          (target.name === "agent" &&
          bundle.nodeId === undefined &&
          this.#ctx.get(ParentSessionKey) === undefined
            ? { name: "agent", nodeId: ROOT_RUNTIME_AGENT_NODE_ID }
            : undefined))
        : undefined;
    if (target.kind === "agent" && definition === undefined)
      throw new Error(`Agent "${target.name}" is not available to this session.`);
    if (target.kind === "remote") {
      const url = new URL(target.url);
      if (
        url.protocol !== "https:" ||
        isPrivateOrReservedIpAddress(url.hostname) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error(
          "Registered remote agents require an HTTPS URL without credentials or a fragment.",
        );
    }
    const store = this.#state;
    const sequence = (store.registrationSequence ?? 0) + 1;
    const hash = createHash("sha256")
      .update(`${this.#sessionId}:${sequence}:${destination.key}`)
      .digest("hex")
      .slice(0, 16);
    const id = `ag_registered:${hash}`;
    const handle: AgentRegistryEntry = {
      phase: "registered",
      identity: {
        id,
        name: definition?.name ?? destination.key,
        nodeId: definition?.nodeId ?? id,
        registration: { ...destination, visible: true },
      },
    };
    this.#write({
      ...store,
      handles: [...store.handles, handle],
      registrationSequence: sequence,
    });
    return { id };
  }

  update(reference: AgentReference, description: string): void {
    const current = this.resolve(reference.id);
    const registration = current.identity.registration;
    if (!registration) throw new Error("Only registered destinations can be updated.");
    this.#write({
      ...this.#state,
      handles: this.entries.map((handle) =>
        handle.identity.id === current.identity.id
          ? {
              ...handle,
              identity: { ...handle.identity, registration: { ...registration, description } },
            }
          : handle,
      ),
    });
  }

  unregister(reference: AgentReference): void {
    const current = this.resolve(reference.id);
    const registration = current.identity.registration;
    if (!registration) throw new Error("Only registered destinations can be unregistered.");
    this.#write({
      ...this.#state,
      handles: this.entries.flatMap((handle): readonly AgentRegistryEntry[] => {
        if (handle.identity.id !== current.identity.id) return [handle];
        if (handle.phase === "registered") return [];
        return [
          {
            ...handle,
            identity: { ...handle.identity, registration: { ...registration, visible: false } },
          },
        ];
      }),
    });
  }

  resolve(id: string): AgentRegistryEntry {
    const handle = this.entries.find((entry) => entry.identity.id === id);
    if (!handle || handle.identity.registration?.visible === false)
      throw new Error("Unknown or unregistered agent handle.");
    return handle;
  }
}

function sameTarget(
  first: AgentDestination["target"],
  second: AgentDestination["target"],
): boolean {
  if (first.kind === "agent") return second.kind === "agent" && first.name === second.name;
  return (
    second.kind === "remote" && first.url === second.url && first.sessionId === second.sessionId
  );
}
