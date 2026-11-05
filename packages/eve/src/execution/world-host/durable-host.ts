import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { Runtime } from "#channel/types.js";
import type { Entities } from "#execution/entity/entities.js";
import type { DurableHost } from "#execution/hosts.js";
import type { SessionLineStore } from "#execution/session-line-store.js";
import { logicalSessionInboxToken, logicalSessionToken } from "#execution/session-inbox/address.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { RunNotFoundError } from "#shared/run-errors.js";
import type { SessionMessage } from "./driver.js";

// A World host as its realm's durable host: what no route in this process holds goes to the
// World, as it would go to Workflow on a deployment. A hook or a session's inbox is resumed by
// sending to the entity of the session that has that address; a runtime asked for (a schedule's
// occurrence starts in one) is the host's runtime for the agent; a stream is read from the World.
//
// Not yet: the runs an activation holds live in its memory, so a run's status and cancelling one
// from elsewhere are refused, and so are connection event watches, which need a durable owner.

export const WORLD_DURABLE_HOST_NAME = "eve/world-host";

export function worldDurableHost(input: {
  readonly entities: Entities;
  readonly lineStore: SessionLineStore;
  /** The host's runtime for its agent compiled from `source`, if it has one. */
  readonly runtimeFor: (source: RuntimeCompiledArtifactsSource) => Runtime | undefined;
}): DurableHost {
  const { entities } = input;
  const send = async (alias: string, payload: unknown) => {
    const sent = await entities.send({ alias }, { deliver: payload } satisfies SessionMessage);
    if (sent === undefined) throw new HookNotFoundError(alias);
  };
  const unavailable = (what: string) => {
    throw new Error(`${what} isn't available on a World host yet.`);
  };
  return {
    name: WORLD_DURABLE_HOST_NAME,
    async resumeHook(token, payload) {
      await send(logicalSessionInboxToken(token) ?? token, payload);
    },
    async resumeSessionInbox(address, delivery) {
      await send(logicalSessionToken(address), delivery);
    },
    async runStatus(runId) {
      throw new RunNotFoundError(runId);
    },
    async cancelRun(runId) {
      throw new RunNotFoundError(runId);
    },
    lineStore: input.lineStore,
    stepAttempt: () => undefined,
    createRuntime({ compiledArtifactsSource }) {
      const runtime = input.runtimeFor(compiledArtifactsSource);
      if (runtime === undefined)
        throw new Error("This World host has no agent compiled from those artifacts.");
      return runtime;
    },
    connectionEvents: {
      find: async () => undefined,
      start: async () => unavailable("Watching a connection's events"),
      retire: async () => false,
    },
  };
}
