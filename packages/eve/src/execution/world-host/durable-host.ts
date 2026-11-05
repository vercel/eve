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
// What isn't a session goes to `fallback`, when the host has one: Workflow, in a build whose
// authored workflow tools run as Workflow runs. Their hooks, status and cancelling are Workflow's,
// and so are connection event watches. Without one, those are refused: the runs an activation
// holds live in its memory.

export const WORLD_DURABLE_HOST_NAME = "eve/world-host";

export function worldDurableHost(input: {
  readonly entities: Entities;
  readonly lineStore: SessionLineStore;
  /** The host's runtime for its agent compiled from `source`, if it has one. */
  readonly runtimeFor: (source: RuntimeCompiledArtifactsSource) => Runtime | undefined;
  /** Where what isn't a session goes. */
  readonly fallback?: DurableHost;
}): DurableHost {
  const { entities, fallback } = input;
  /** Whether a session had `alias`, which then has `payload`. */
  const sent = async (alias: string, payload: unknown) =>
    (await entities.send({ alias }, { deliver: payload } satisfies SessionMessage)) !== undefined;
  const unavailable = (what: string) => {
    throw new Error(`${what} isn't available on a World host yet.`);
  };
  return {
    name: WORLD_DURABLE_HOST_NAME,
    ...(fallback !== undefined && { wraps: fallback.name }),
    async resumeHook(token, payload) {
      const alias = logicalSessionInboxToken(token) ?? token;
      if (await sent(alias, payload)) return;
      if (fallback === undefined) throw new HookNotFoundError(alias);
      await fallback.resumeHook(token, payload);
    },
    async resumeSessionInbox(address, delivery) {
      const alias = logicalSessionToken(address);
      if (await sent(alias, delivery)) return;
      if (fallback === undefined) throw new HookNotFoundError(alias);
      await fallback.resumeSessionInbox(address, delivery);
    },
    async runStatus(runId) {
      if (fallback === undefined) throw new RunNotFoundError(runId);
      return await fallback.runStatus(runId);
    },
    async cancelRun(runId, reason) {
      if (fallback === undefined) throw new RunNotFoundError(runId);
      await fallback.cancelRun(runId, reason);
    },
    lineStore: input.lineStore,
    // A Workflow step's attempt, inside one.
    stepAttempt: () => fallback?.stepAttempt(),
    createRuntime({ compiledArtifactsSource }) {
      const runtime = input.runtimeFor(compiledArtifactsSource);
      if (runtime === undefined)
        throw new Error("This World host has no agent compiled from those artifacts.");
      return runtime;
    },
    connectionEvents: fallback?.connectionEvents ?? {
      find: async () => undefined,
      start: async () => unavailable("Watching a connection's events"),
      retire: async () => false,
    },
  };
}
